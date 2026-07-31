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
import { convertToCodexRequest, buildUserContent } from '../server.js';

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

  test('a dead provider is not masked by a healthy one', async () => {
    // Regression guard: /health used to report "ok" whenever *any* provider was
    // valid, which let a completely broken Anthropic go unnoticed for weeks.
    //
    // Asserted as an invariant rather than against a named provider: Anthropic
    // has Keychain/CLI-credential fallbacks, so which providers resolve depends
    // on the machine the tests run on.
    const { body } = await api('/health');
    const unhealthy = Object.entries(body.providers)
      .filter(([, p]) => p.status !== 'valid')
      .map(([name]) => name);

    assert.deepEqual(body.unhealthyProviders ?? [], unhealthy,
      'unhealthyProviders must list exactly the non-valid providers');
    assert.equal(body.status === 'ok', unhealthy.length === 0,
      'status may be "ok" only when every provider is valid');
    if (unhealthy.length > 0 && unhealthy.length < Object.keys(body.providers).length) {
      assert.equal(body.status, 'degraded');
    }
  });

  test('health exposes per-provider refresh state', async () => {
    const { body } = await api('/health');
    for (const provider of ['anthropic', 'openai']) {
      const refresh = body.providers[provider]?.refresh;
      assert.ok(refresh, `${provider} should report refresh state`);
      assert.equal(typeof refresh.consecutiveFailures, 'number');
      assert.ok('lastError' in refresh);
      assert.ok('lastSuccessAt' in refresh);
    }
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

  test('OPENAI_ACCESS_TOKEN set but no OPENAI_ACCOUNT_ID → not blocked, reaches upstream', async () => {
    // The ChatGPT backend does not require the chatgpt-account-id header, so a
    // missing accountId must not short-circuit the request. It should travel
    // upstream and fail on the (fake) token instead.
    const { status, body } = await api('/v1/chat/completions',
      authed(post({ model: 'gpt-5.4', messages: [{ role: 'user', content: 'hi' }] })));
    assert.equal(status, 503);
    assert.doesNotMatch(body.error.message, /accountId/i);
    assert.match(body.error.message, /authentication failed/i);
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

// ─── Request conversion: Chat Completions → Codex Responses ──────────────────
// Pure-function tests (no server, no upstream). These cover the multimodal path
// that previously dropped image blocks and silently produced a body with no
// `input`, which the backend rejected as "Missing required parameter: 'input'".

describe('convertToCodexRequest — multimodal', () => {
  const userMsg = (content) => ({ model: 'gpt-5.4-mini', messages: [{ role: 'user', content }] });

  test('text + image_url → input_text + input_image (text is not lost)', () => {
    const { error, codexBody } = convertToCodexRequest(userMsg([
      { type: 'text', text: '这是什么？' },
      { type: 'image_url', image_url: { url: 'https://example.com/a.jpg' } },
    ]));
    assert.equal(error, undefined);
    assert.equal(codexBody.input.length, 1);
    assert.deepEqual(codexBody.input[0].content, [
      { type: 'input_text', text: '这是什么？' },
      { type: 'input_image', image_url: 'https://example.com/a.jpg' },
    ]);
  });

  test('image-only content still produces a message', () => {
    const { error, codexBody } = convertToCodexRequest(userMsg([
      { type: 'image_url', image_url: { url: 'https://example.com/a.jpg' } },
    ]));
    assert.equal(error, undefined);
    assert.deepEqual(codexBody.input[0].content, [
      { type: 'input_image', image_url: 'https://example.com/a.jpg' },
    ]);
  });

  test('multiple images are all forwarded in order', () => {
    const { codexBody } = convertToCodexRequest(userMsg([
      { type: 'text', text: 'compare' },
      { type: 'image_url', image_url: { url: 'https://example.com/1.jpg' } },
      { type: 'image_url', image_url: { url: 'https://example.com/2.jpg' } },
    ]));
    assert.deepEqual(codexBody.input[0].content.map(b => b.type),
      ['input_text', 'input_image', 'input_image']);
    assert.equal(codexBody.input[0].content[2].image_url, 'https://example.com/2.jpg');
  });

  test('data: URI is passed through untouched', () => {
    const dataUri = 'data:image/png;base64,iVBORw0KGgo=';
    const { codexBody } = convertToCodexRequest(userMsg([
      { type: 'image_url', image_url: { url: dataUri } },
    ]));
    assert.equal(codexBody.input[0].content[0].image_url, dataUri);
  });

  test('detail is forwarded when present, omitted when absent', () => {
    const withDetail = convertToCodexRequest(userMsg([
      { type: 'image_url', image_url: { url: 'https://example.com/a.jpg', detail: 'high' } },
    ])).codexBody;
    assert.equal(withDetail.input[0].content[0].detail, 'high');

    const without = convertToCodexRequest(userMsg([
      { type: 'image_url', image_url: { url: 'https://example.com/a.jpg' } },
    ])).codexBody;
    assert.equal('detail' in without.input[0].content[0], false);
  });

  test('shorthand image_url as a bare string is accepted', () => {
    const { codexBody } = convertToCodexRequest(userMsg([
      { type: 'image_url', image_url: 'https://example.com/a.jpg' },
    ]));
    assert.deepEqual(codexBody.input[0].content, [
      { type: 'input_image', image_url: 'https://example.com/a.jpg' },
    ]);
  });

  test('image_url without a usable url is skipped, not fatal', () => {
    const { error, codexBody } = convertToCodexRequest(userMsg([
      { type: 'text', text: 'hi' },
      { type: 'image_url', image_url: {} },
    ]));
    assert.equal(error, undefined);
    assert.deepEqual(codexBody.input[0].content, [{ type: 'input_text', text: 'hi' }]);
  });
});

describe('convertToCodexRequest — text paths (regression)', () => {
  test('string content → input_text', () => {
    const { codexBody } = convertToCodexRequest({ model: 'gpt-5.4-mini', messages: [{ role: 'user', content: 'hello' }] });
    assert.deepEqual(codexBody.input[0].content, [{ type: 'input_text', text: 'hello' }]);
  });

  test('text-only array content → input_text', () => {
    const { codexBody } = convertToCodexRequest({
      model: 'gpt-5.4-mini',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    });
    assert.deepEqual(codexBody.input[0].content, [{ type: 'input_text', text: 'hello' }]);
  });

  test('system message with an image block keeps its text in instructions', () => {
    const { codexBody } = convertToCodexRequest({
      model: 'gpt-5.4-mini',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'be terse' }, { type: 'image_url', image_url: { url: 'https://example.com/a.jpg' } }] },
        { role: 'user', content: 'hi' },
      ],
    });
    assert.equal(codexBody.instructions, 'be terse');
  });

  test('reasoning_effort still passes through alongside images', () => {
    const { codexBody } = convertToCodexRequest({
      model: 'gpt-5.4-mini',
      reasoning_effort: 'high',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.jpg' } }] }],
    });
    assert.deepEqual(codexBody.reasoning, { effort: 'high' });
  });
});

describe('convertToCodexRequest — empty input is caught locally', () => {
  test('no messages → 400-shaped error, never a body without input', () => {
    const { error, codexBody } = convertToCodexRequest({ model: 'gpt-5.4-mini', messages: [] });
    assert.equal(codexBody, undefined);
    assert.equal(error.type, 'invalid_request_error');
    assert.equal(error.param, 'messages');
  });

  test('system-only conversation → explicit error, not a malformed upstream call', () => {
    const { error } = convertToCodexRequest({
      model: 'gpt-5.4-mini',
      messages: [{ role: 'system', content: 'be terse' }],
    });
    assert.equal(error.type, 'invalid_request_error');
  });
});

describe('buildUserContent', () => {
  test('empty string yields no blocks', () => {
    assert.deepEqual(buildUserContent(''), []);
  });

  test('null/undefined content yields no blocks', () => {
    assert.deepEqual(buildUserContent(null), []);
    assert.deepEqual(buildUserContent(undefined), []);
  });
});
