/**
 * Unified Proxy — automated tests (Node.js built-in test runner)
 *
 * Run:  npm test
 *
 * The tests start a local server on port 13456 with PROXY_API_KEY=test-key
 * and NO upstream OAuth tokens. This lets us verify:
 *   - Auth middleware (401 paths)
 *   - Health check (always public)
 *   - /v1/models structure
 *   - Request validation (400)
 *   - Default model fallback (routes to Anthropic → 503 "no tokens", not 401/400)
 *   - OpenAI model routing (routes to OpenAI → 503 "no tokens")
 *   - 404 for unknown paths
 *
 * Upstream inference is NOT tested here — that requires real OAuth tokens
 * and is covered by the CD smoke test and manual UAT.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', 'server.js');
const PORT = 13456;
const KEY = 'test-key-unified-proxy';
const BASE = `http://127.0.0.1:${PORT}`;

let proc;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function api(path, opts = {}, base = BASE) {
  const res = await fetch(`${base}${path}`, opts);
  let body;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

function authed(extra = {}) {
  return { ...extra, headers: { Authorization: `Bearer ${KEY}`, ...extra.headers } };
}

function post(data, extra = {}) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extra.headers },
    body: JSON.stringify(data),
    ...extra,
  };
}

async function startServer(extraEnv = {}) {
  const p = spawn('node', [SERVER], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      PROXY_API_KEY: KEY,
      PROXY_AUTH_FILE: '/nonexistent/test-auth.json',
      CLAUDE_ACCESS_TOKEN: '',
      OPENAI_ACCESS_TOKEN: '',
      OPENAI_ACCOUNT_ID: '',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      ...extraEnv,
    },
    stdio: 'pipe',
  });
  p.stderr.on('data', () => {});
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try { await fetch(`${BASE}/health`); return p; } catch { await new Promise(r => setTimeout(r, 200)); }
  }
  throw new Error('Server did not start within 8s');
}

// ─── Server lifecycle ─────────────────────────────────────────────────────────

before(async () => { proc = await startServer(); });
after(() => proc?.kill());

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Health check', () => {
  test('GET /health is public (no key required)', async () => {
    const { status, body } = await api('/health');
    assert.equal(status, 200);
    assert.equal(body.mode, 'unified-proxy');
    assert.ok(body.version, 'should include version');
    assert.ok(body.providers, 'should include providers');
  });

  test('GET / also returns health', async () => {
    const { status } = await api('/');
    assert.equal(status, 200);
  });
});

describe('Authentication', () => {
  test('GET /v1/models — no key → 401', async () => {
    const { status } = await api('/v1/models');
    assert.equal(status, 401);
  });

  test('GET /v1/models — wrong key → 401', async () => {
    const { status } = await api('/v1/models', {
      headers: { Authorization: 'Bearer wrong-key' },
    });
    assert.equal(status, 401);
  });

  test('GET /v1/models — correct key → 200', async () => {
    const { status } = await api('/v1/models', authed());
    assert.equal(status, 200);
  });

  test('POST /v1/chat/completions — no key → 401', async () => {
    const { status } = await api('/v1/chat/completions',
      post({ messages: [{ role: 'user', content: 'hi' }] }));
    assert.equal(status, 401);
  });
});

describe('Models endpoint', () => {
  test('returns OpenAI-compatible list structure', async () => {
    const { body } = await api('/v1/models', authed());
    assert.equal(body.object, 'list');
    assert.ok(Array.isArray(body.data));
    assert.ok(body.data.length > 0);
  });

  test('includes Anthropic models', async () => {
    const { body } = await api('/v1/models', authed());
    const ids = body.data.map(m => m.id);
    assert.ok(ids.some(id => id.startsWith('claude-')), 'expected at least one claude model');
  });

  test('includes OpenAI models', async () => {
    const { body } = await api('/v1/models', authed());
    const ids = body.data.map(m => m.id);
    assert.ok(
      ids.some(id => id.startsWith('gpt-') || id.startsWith('o3') || id.startsWith('o4')),
      'expected at least one openai model',
    );
  });

  test('each model has id and owned_by', async () => {
    const { body } = await api('/v1/models', authed());
    for (const m of body.data) {
      assert.ok(m.id, `model missing id: ${JSON.stringify(m)}`);
      assert.ok(m.owned_by, `model missing owned_by: ${JSON.stringify(m)}`);
    }
  });
});

describe('Chat completions — request validation', () => {
  test('missing messages → 400', async () => {
    const { status, body } = await api('/v1/chat/completions',
      authed(post({})));
    assert.equal(status, 400);
    assert.ok(body.error);
  });

  test('no model field → uses default (routes to Anthropic, auth+validation pass)', async () => {
    const { status, body } = await api('/v1/chat/completions',
      authed(post({ messages: [{ role: 'user', content: 'hi' }] })));
    // Auth passed (not 401), messages valid (not 400)
    // May be 200 (token available) or 503 (no token) — both confirm correct routing
    assert.notEqual(status, 401, 'should not fail auth');
    assert.notEqual(status, 400, 'should not fail validation');
    if (status === 503) assert.match(body.error.message, /anthropic/i);
  });

  test('claude model → routes to Anthropic (auth+validation pass)', async () => {
    const { status, body } = await api('/v1/chat/completions',
      authed(post({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] })));
    assert.notEqual(status, 401, 'should not fail auth');
    assert.notEqual(status, 400, 'should not fail validation');
    if (status === 503) assert.match(body.error.message, /anthropic/i);
  });

  test('gpt model → routes to OpenAI → 503 no token', async () => {
    const { status, body } = await api('/v1/chat/completions',
      authed(post({ model: 'gpt-5.2', messages: [{ role: 'user', content: 'hi' }] })));
    assert.equal(status, 503);
    assert.match(body.error.message, /openai/i);
  });

  test('o3 model → routes to OpenAI → 503 no token', async () => {
    const { status, body } = await api('/v1/chat/completions',
      authed(post({ model: 'o3-pro', messages: [{ role: 'user', content: 'hi' }] })));
    assert.equal(status, 503);
    assert.match(body.error.message, /openai/i);
  });
});

describe('404', () => {
  test('unknown path → 404', async () => {
    const { status } = await api('/nonexistent', authed());
    assert.equal(status, 404);
  });
});

// ─── OpenAI env var fallback ──────────────────────────────────────────────────

describe('OpenAI env var fallback', () => {
  let proc2;

  before(async () => {
    proc?.kill();
    proc = null;
    proc2 = await startServer({ OPENAI_ACCESS_TOKEN: 'fake-token-for-testing' });
  });

  after(() => {
    proc2?.kill();
    proc2 = null;
  });

  test('OPENAI_ACCESS_TOKEN set but no OPENAI_ACCOUNT_ID → 503 missing accountId', async () => {
    const { status, body } = await api('/v1/chat/completions',
      authed(post({ model: 'gpt-5.2', messages: [{ role: 'user', content: 'hi' }] })));
    assert.equal(status, 503);
    assert.match(body.error.message, /accountId|account/i);
  });

  test('OPENAI_ACCESS_TOKEN + OPENAI_ACCOUNT_ID set → token loads, request reaches upstream', async () => {
    proc2?.kill();
    proc2 = await startServer({
      OPENAI_ACCESS_TOKEN: 'fake-token-for-testing',
      OPENAI_ACCOUNT_ID: 'fake-account-id',
    });
    const { status, body } = await api('/v1/chat/completions',
      authed(post({ model: 'gpt-5.2', messages: [{ role: 'user', content: 'hi' }] })));
    assert.notEqual(status, 401, 'should not fail proxy auth');
    assert.notEqual(status, 400, 'should not fail validation');
    // Token was loaded and accountId passed — request reached upstream.
    // With a fake token, upstream returns 401 → refresh fails → 503 "authentication failed after refresh".
    // This is distinct from "no token" 503 (getOAuthTokens throws) or "missing accountId" 503.
    if (status === 503) {
      assert.match(body.error.message, /authentication failed after refresh/i,
        'expected upstream auth failure, not a "no token" or "missing accountId" error');
    }
  });
});
