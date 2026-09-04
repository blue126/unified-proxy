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
import {
  convertToCodexRequest,
  buildUserContent,
  convertMessages,
  buildAnthropicContent,
  CodexSSETransformer,
  extractSSEPayloads,
  classifyRefreshFailure,
  createRefreshState,
  recordRefreshFailure,
  refreshDecisionForState,
  refreshRetryDelayMs,
  registerModelProviders,
  routeRequest,
  stripPrefix,
} from '../server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', 'server.js');
const PORT = 13456;
const KEY = 'test-key-unified-proxy';
const BASE = `http://127.0.0.1:${PORT}`;
// Keep the spawned server from finding a developer's real Claude credentials
// through ~/.claude, the legacy auth location, or the macOS Keychain. The test
// suite deliberately starts without upstream tokens and must not make live API
// calls just because the machine running it happens to be logged in.
const TEST_HOME = `/tmp/unified-proxy-test-home-${process.pid}`;
const EMPTY_PATH = '/nonexistent';

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
  const p = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      HOME: TEST_HOME,
      PATH: EMPTY_PATH,
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
      assert.ok(['healthy', 'backoff', 'retry_due', 'reauth_required'].includes(refresh.status));
      assert.ok('lastError' in refresh);
      assert.ok('lastSuccessAt' in refresh);
      assert.ok('nextRetryAt' in refresh);
    }
  });
});

describe('OAuth refresh failure policy', () => {
  test('invalid_grant and invalid refresh-token responses are permanent', () => {
    assert.equal(classifyRefreshFailure(400, '{"error":"invalid_grant"}'), 'permanent');
    assert.equal(classifyRefreshFailure(401, 'Refresh token revoked'), 'permanent');
    assert.equal(classifyRefreshFailure(400, 'Refresh token not found or invalid'), 'permanent');
  });

  test('timeouts, rate limits, server errors, and unrelated 4xx responses are transient', () => {
    assert.equal(classifyRefreshFailure(0, 'timed out'), 'transient');
    assert.equal(classifyRefreshFailure(429, 'rate limited'), 'transient');
    assert.equal(classifyRefreshFailure(503, 'unavailable'), 'transient');
    assert.equal(classifyRefreshFailure(400, 'invalid_client'), 'transient');
  });

  test('transient failures use capped exponential backoff', () => {
    assert.equal(refreshRetryDelayMs(1), 60_000);
    assert.equal(refreshRetryDelayMs(2), 120_000);
    assert.equal(refreshRetryDelayMs(5), 960_000);
    assert.equal(refreshRetryDelayMs(6), 1_800_000);
    assert.equal(refreshRetryDelayMs(100), 1_800_000);
  });

  test('backoff blocks request-triggered retries until the deadline', () => {
    const state = createRefreshState();
    recordRefreshFailure(state, {
      error: 'temporary network failure',
      refreshToken: 'refresh-a',
      now: 1_000,
    });

    assert.deepEqual(refreshDecisionForState(state, 'refresh-a', 60_999), {
      allowed: false,
      reason: 'backoff',
      nextRetryAt: 61_000,
    });
    assert.deepEqual(refreshDecisionForState(state, 'refresh-a', 61_000), {
      allowed: true,
      reason: 'retry_due',
    });
  });

  test('permanent failure stays open until a different refresh token is installed', () => {
    const state = createRefreshState();
    recordRefreshFailure(state, {
      error: 'HTTP 400: invalid_grant',
      permanent: true,
      refreshToken: 'refresh-a',
      now: 1_000,
    });

    assert.equal(state.reauthRequired, true);
    assert.equal(state.nextRetryAt, null);
    assert.deepEqual(refreshDecisionForState(state, 'refresh-a', 999_999_999), {
      allowed: false,
      reason: 'reauth_required',
    });
    assert.deepEqual(refreshDecisionForState(state, 'refresh-b', 2_000), {
      allowed: true,
      reason: 'credentials_replaced',
    });
  });
});

describe('Provider-aware model routing', () => {
  test('explicit provider prefixes take priority and are removed upstream', () => {
    assert.equal(routeRequest('openai/future-reasoner'), 'openai');
    assert.equal(stripPrefix('openai/future-reasoner'), 'future-reasoner');
    assert.equal(routeRequest('anthropic/future-reasoner'), 'anthropic');
    assert.equal(stripPrefix('anthropic/future-reasoner'), 'future-reasoner');
  });

  test('live catalog ownership routes names that do not match legacy patterns', () => {
    registerModelProviders('openai', [{ id: 'nova-reasoner-test' }]);
    registerModelProviders('anthropic', [{ id: 'aurora-assistant-test' }]);
    assert.equal(routeRequest('nova-reasoner-test'), 'openai');
    assert.equal(routeRequest('aurora-assistant-test'), 'anthropic');
  });

  test('legacy rules remain compatible and cover future o-series numbers', () => {
    assert.equal(routeRequest('gpt-5.6'), 'openai');
    assert.equal(routeRequest('o5-pro'), 'openai');
    assert.equal(routeRequest('codex-next'), 'openai');
    assert.equal(routeRequest('claude-sonnet-next'), 'anthropic');
    assert.equal(routeRequest('sonnet'), 'anthropic');
  });

  test('ambiguous catalog ownership requires an explicit prefix', () => {
    registerModelProviders('openai', [{ id: 'shared-model-test' }]);
    registerModelProviders('anthropic', [{ id: 'shared-model-test' }]);
    assert.throws(
      () => routeRequest('shared-model-test'),
      error => error.code === 'ambiguous_model_provider' && /explicit|openai\//i.test(error.message),
    );
    assert.equal(routeRequest('openai/shared-model-test'), 'openai');
    assert.equal(routeRequest('anthropic/shared-model-test'), 'anthropic');
  });

  test('unknown unprefixed models fail closed instead of defaulting to Anthropic', () => {
    assert.throws(
      () => routeRequest('unclassified-model-test'),
      error => error.code === 'unknown_model_provider' && /openai\//i.test(error.message),
    );
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

  test('explicit prefixes route future model names without catalog knowledge', async () => {
    const openai = await api('/v1/chat/completions',
      authed(post({ model: 'openai/future-api-model-test', messages: [{ role: 'user', content: 'hi' }] })));
    assert.equal(openai.status, 503);
    assert.match(openai.body.error.message, /openai/i);

    const anthropic = await api('/v1/chat/completions',
      authed(post({ model: 'anthropic/future-api-model-test', messages: [{ role: 'user', content: 'hi' }] })));
    assert.equal(anthropic.status, 503);
    assert.match(anthropic.body.error.message, /anthropic/i);
  });

  test('unknown unprefixed model → 400 with actionable provider guidance', async () => {
    const { status, body } = await api('/v1/chat/completions',
      authed(post({ model: 'unknown-api-model-test', messages: [{ role: 'user', content: 'hi' }] })));
    assert.equal(status, 400);
    assert.equal(body.error.code, 'unknown_model_provider');
    assert.equal(body.error.param, 'model');
    assert.match(body.error.message, /openai\//i);
    assert.match(body.error.message, /anthropic\//i);
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
    assert.match(body.error.message, /require re-authentication/i);
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
    // With a fake token, upstream returns 401 and no refresh token exists, so
    // the provider enters the explicit re-authentication-required state.
    // This is distinct from "no token" 503 (getOAuthTokens throws) or "missing accountId" 503.
    if (status === 503) {
      assert.match(body.error.message, /require re-authentication/i,
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

describe('CodexSSETransformer', () => {
  test('recovers a later final-answer item that was only present in output_item.done', () => {
    const transformer = new CodexSSETransformer('gpt-5.4-mini');
    const content = [];
    const collect = event => {
      for (const chunk of transformer.transform(event)) {
        if (chunk.choices?.[0]?.delta?.content) content.push(chunk.choices[0].delta.content);
      }
    };

    collect({ type: 'response.output_text.delta', item_id: 'msg_1', delta: 'I will inspect it.' });
    collect({
      type: 'response.output_item.done',
      item: { id: 'msg_1', type: 'message', phase: 'commentary', content: [{ type: 'output_text', text: 'I will inspect it.' }] },
    });
    collect({
      type: 'response.output_item.done',
      item: { id: 'msg_2', type: 'message', phase: 'final_answer', content: [{ type: 'output_text', text: 'The final answer.' }] },
    });
    collect({ type: 'response.completed', response: { status: 'completed' } });

    assert.equal(content.join(''), 'I will inspect it.The final answer.');
    assert.equal(transformer.terminalReceived, true);
  });

  test('recovers message text from the completed response snapshot', () => {
    const transformer = new CodexSSETransformer('gpt-5.4-mini');
    const chunks = transformer.transform({
      type: 'response.completed',
      response: {
        status: 'completed',
        output: [{ id: 'msg_1', type: 'message', content: [{ type: 'output_text', text: 'complete text' }] }],
      },
    });
    assert.equal(chunks.find(chunk => chunk.choices?.[0]?.delta?.content)?.choices[0].delta.content, 'complete text');
    assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
  });

  test('maps an incomplete response to length even after a tool call', () => {
    const transformer = new CodexSSETransformer('gpt-5.4-mini');
    transformer.transform({ type: 'response.output_item.added', item: { id: 'fc_1', type: 'function_call', name: 'read' } });
    const chunks = transformer.transform({
      type: 'response.incomplete',
      response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
    });
    assert.equal(chunks.at(-1).choices[0].finish_reason, 'length');
  });

  test('surfaces failed upstream responses', () => {
    const transformer = new CodexSSETransformer('gpt-5.4-mini');
    assert.throws(() => transformer.transform({
      type: 'response.failed',
      response: { error: { message: 'generation failed' } },
    }), /generation failed/);
  });
});

describe('extractSSEPayloads', () => {
  test('keeps partial lines and flushes a final event without a newline', () => {
    const partial = extractSSEPayloads('data: {"type":"response.created"}\ndata: {"type"');
    assert.deepEqual(partial.payloads, ['{"type":"response.created"}']);
    assert.equal(partial.remainder, 'data: {"type"');

    const flushed = extractSSEPayloads(partial.remainder + ':"response.completed"}', true);
    assert.deepEqual(flushed.payloads, ['{"type":"response.completed"}']);
    assert.equal(flushed.remainder, '');
  });
});

// ─── Request conversion: Chat Completions → Anthropic Messages ───────────────
// The Anthropic path had the same defect the Codex path did: image_url blocks
// were filtered out by extractText(), so Claude received text only and replied
// "I don't see an image" while the caller saw a perfectly successful response.

describe('convertMessages — multimodal', () => {
  const IMG = 'https://example.com/a.jpg';
  const userMsg = (content) => [{ role: 'user', content }];

  test('text + image_url → text block + image block', () => {
    const { messages } = convertMessages(userMsg([
      { type: 'text', text: '这是什么？' },
      { type: 'image_url', image_url: { url: IMG } },
    ]));
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0].content, [
      { type: 'text', text: '这是什么？' },
      { type: 'image', source: { type: 'url', url: IMG } },
    ]);
  });

  test('data: URI becomes a base64 source with media_type', () => {
    const { messages } = convertMessages(userMsg([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    ]));
    assert.deepEqual(messages[0].content, [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
    ]);
  });

  test('multiple images all survive, in order', () => {
    const { messages } = convertMessages(userMsg([
      { type: 'text', text: 'compare' },
      { type: 'image_url', image_url: { url: 'https://example.com/1.jpg' } },
      { type: 'image_url', image_url: { url: 'https://example.com/2.jpg' } },
    ]));
    assert.deepEqual(messages[0].content.map(b => b.type), ['text', 'image', 'image']);
    assert.equal(messages[0].content[2].source.url, 'https://example.com/2.jpg');
  });

  test('shorthand bare-string image_url is accepted', () => {
    const { messages } = convertMessages(userMsg([
      { type: 'image_url', image_url: IMG },
    ]));
    assert.deepEqual(messages[0].content, [{ type: 'image', source: { type: 'url', url: IMG } }]);
  });

  test('consecutive user messages merge without losing the image', () => {
    const { messages } = convertMessages([
      { role: 'user', content: 'first' },
      { role: 'user', content: [{ type: 'text', text: 'second' }, { type: 'image_url', image_url: { url: IMG } }] },
    ]);
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0].content, [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
      { type: 'image', source: { type: 'url', url: IMG } },
    ]);
  });

  test('tool context is prepended as a text block, image preserved', () => {
    const { messages } = convertMessages(
      userMsg([{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: IMG } }]),
      [{ type: 'function', function: { name: 'foo', description: 'does foo' } }],
    );
    assert.equal(messages[0].content[0].type, 'text');
    assert.match(messages[0].content[0].text, /Available Tools/);
    assert.deepEqual(messages[0].content.at(-1), { type: 'image', source: { type: 'url', url: IMG } });
  });
});

describe('convertMessages — text-only behaviour is unchanged', () => {
  test('string content stays a plain string', () => {
    const { messages } = convertMessages([{ role: 'user', content: 'hello' }]);
    assert.equal(messages[0].content, 'hello');
  });

  test('text-only array content collapses to a plain string', () => {
    const { messages } = convertMessages([
      { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
    ]);
    assert.equal(messages[0].content, 'a\nb');
  });

  test('consecutive text-only user messages still merge with a blank line', () => {
    const { messages } = convertMessages([
      { role: 'user', content: 'first' },
      { role: 'user', content: 'second' },
    ]);
    assert.equal(messages[0].content, 'first\n\nsecond');
  });

  test('image_url with no usable url is skipped', () => {
    const { messages } = convertMessages([
      { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: {} }] },
    ]);
    assert.deepEqual(messages[0].content, [{ type: 'text', text: 'hi' }]);
  });
});

describe('buildAnthropicContent', () => {
  test('no-image array returns a string, not blocks', () => {
    assert.equal(typeof buildAnthropicContent([{ type: 'text', text: 'x' }]), 'string');
  });

  test('array containing an image returns blocks', () => {
    assert.ok(Array.isArray(buildAnthropicContent([{ type: 'image_url', image_url: { url: 'https://e/1.jpg' } }])));
  });
});
