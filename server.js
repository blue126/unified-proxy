#!/usr/bin/env node

/**
 * Unified Proxy v5.0.0 - Multi-Provider OAuth
 * - Anthropic: PKCE OAuth login via `--login` or `--login anthropic` (paste-code mode)
 * - OpenAI: PKCE OAuth login via `--login openai` (localhost callback mode)
 * - `--login all`: Complete both providers sequentially
 * - Dual-provider auth.json with independent refresh chains
 * - Model-based routing: gpt-/o1/o3/o4 prefixes to OpenAI, others to Anthropic
 * - OpenAI: direct passthrough (no format conversion needed)
 * - Anthropic: OpenAI-to-Anthropic format conversion + XML tool call bridge
 */

import { createServer } from 'node:http';
import { execSync } from 'node:child_process';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const PORT = process.env.PORT || 3456;
const HOST = process.env.HOST || '127.0.0.1';
const VERSION = '5.0.0';
const PROXY_API_KEY = process.env.PROXY_API_KEY || null;
// Successful requests are logged only when this is set; failures always are.
const LOG_ALL_REQUESTS = process.env.LOG_ALL_REQUESTS === '1';

// ─── Anthropic OAuth ───
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models';
const ANTHROPIC_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const ANTHROPIC_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const ANTHROPIC_API_VERSION = '2023-06-01';
const ANTHROPIC_OAUTH_BETA = 'oauth-2025-04-20';
// Claude Code impersonation — the Anthropic counterpart of CODEX_CLI_VERSION.
const CLAUDE_CLI_VERSION = process.env.CLAUDE_CLI_VERSION || '2.1.2';

// ─── OpenAI OAuth (cross-verified: openai/codex, open-hax/codex, codex-proxy) ───
const OPENAI_PLATFORM_API_URL = 'https://api.openai.com/v1/chat/completions';  // 保留，未来 API credits 可用
const OPENAI_CHATGPT_BACKEND_URL = 'https://chatgpt.com/backend-api/codex/responses';  // 订阅计费
const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

// ─── Codex CLI impersonation (required by ChatGPT Backend) ───
// The version we report gates which models the backend will serve us: newer models
// are rejected with "requires a newer version of Codex" until this is bumped.
// Override via env when a new model lands before this default catches up.
const CODEX_CLI_VERSION = process.env.CODEX_CLI_VERSION || '0.150.0';
const CODEX_CLI_UA = `codex_cli_rs/${CODEX_CLI_VERSION}`;
// Authoritative, version-gated model catalog for the signed-in account.
const OPENAI_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models';
const OPENAI_AUTH_URL = 'https://auth.openai.com/oauth/authorize';
const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OPENAI_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const OPENAI_SCOPE_AUTH = 'openid profile email offline_access';
const OPENAI_SCOPE_REFRESH = 'openid profile email';

const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";

// ─── Anthropic Model Aliases (resolve short names → exact version IDs) ───
const ANTHROPIC_MODEL_MAP = {
  'claude-sonnet-4': 'claude-sonnet-4-5-20250929',
  'claude-opus-4': 'claude-opus-4-5-20251101',
  'claude-opus-4-5': 'claude-opus-4-5-20251101',
  'claude-opus-4-6': 'claude-opus-4-6',
  'claude-sonnet-4-5': 'claude-sonnet-4-5-20250929',
  'claude-sonnet-4-6': 'claude-sonnet-4-6',
  'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
  'opus': 'claude-opus-4-5-20251101',
  'sonnet': 'claude-sonnet-4-5-20250929',
  'haiku': 'claude-3-5-haiku-20241022',
};

// ─── Default model + models config file ───
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'claude-sonnet-4-6';
const MODELS_FILE = process.env.PROXY_MODELS_FILE || join(homedir(), '.unified-proxy', 'models.json');

// ─── Model Lists for /v1/models (defaults; override via models.json) ───
// Fallback only — fetchAnthropicModels() serves the live catalog. Refreshed
// 2026-07-31 from the account's actual /v1/models; this list had drifted a full
// generation behind (it still topped out at 4.6 while 5 was already served).
const DEFAULT_ANTHROPIC_MODELS = [
  { id: 'claude-opus-5', name: 'Claude Opus 5' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
  { id: 'claude-fable-5', name: 'Claude Fable 5' },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
];

// Last-resort fallback only. The live catalog is fetched from the ChatGPT backend
// (see fetchOpenAIModels) because OpenAI retires these slugs without notice — a
// hardcoded list silently rots into "model is not supported" errors.
const DEFAULT_OPENAI_MODELS = [
  { id: 'gpt-5.5', name: 'GPT-5.5' },
  { id: 'gpt-5.4', name: 'GPT-5.4' },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini' },
];

// ─── Auth file (dual-section: { anthropic: {...}, openai: {...} }) ───
const AUTH_FILE = process.env.PROXY_AUTH_FILE || join(homedir(), '.unified-proxy', 'auth.json');

// ─── Timeouts for upstream API calls ───
const CONNECT_TIMEOUT_MS = 10_000;  // 10s connect timeout

// ─── Background refresh config ───
const REFRESH_CHECK_INTERVAL = 30 * 60 * 1000;  // 30 min
const REFRESH_AHEAD_MS = 2 * 60 * 60 * 1000;    // 2 hours before expiry
const REFRESH_TIMEOUT_MS = 30_000;              // cap on a single token refresh call

// ─── Token caching (per-provider) ───
let cachedTokens = { anthropic: null, openai: null };
let tokenExpiry = { anthropic: 0, openai: 0 };

// ═══════════════════════════════════════════════════════════════
// §1  Model Routing
// ═══════════════════════════════════════════════════════════════

function routeRequest(model) {
  const bare = stripPrefix(model);
  if (/^(gpt-|o1|o3|o4|codex-)/.test(bare)) return 'openai';
  return 'anthropic';
}

function stripPrefix(model) {
  return (model || '').replace(/^openai\//, '');
}

function resolveAnthropicModel(model) {
  const bare = stripPrefix(model);
  return ANTHROPIC_MODEL_MAP[model] || ANTHROPIC_MODEL_MAP[bare] || bare;
}

function loadModels() {
  try {
    if (existsSync(MODELS_FILE)) {
      const data = JSON.parse(readFileSync(MODELS_FILE, 'utf8'));
      console.log(`[MODELS] Loaded ${data.length} models from ${MODELS_FILE}`);
      return {
        anthropic: data.filter(m => routeRequest(m.id) === 'anthropic'),
        openai:    data.filter(m => routeRequest(m.id) === 'openai'),
      };
    }
  } catch (e) {
    console.error(`[MODELS] Error loading ${MODELS_FILE}: ${e.message}, using defaults`);
  }
  return { anthropic: DEFAULT_ANTHROPIC_MODELS, openai: DEFAULT_OPENAI_MODELS };
}

const { anthropic: ANTHROPIC_MODELS, openai: OPENAI_MODELS } = loadModels();

// ─── Live OpenAI model discovery ───
// The ChatGPT backend exposes the exact catalog it will serve this account, gated
// by the client version we report. Preferred over any static list: OpenAI rotates
// slugs (gpt-5.2 → gpt-5.4 → gpt-5.5 …) and retired ones fail at request time.
const OPENAI_MODELS_TTL_MS = 60 * 60 * 1000;  // 1h
let openaiModelsCache = { fetchedAt: 0, models: null };

async function fetchOpenAIModels() {
  const fresh = Date.now() - openaiModelsCache.fetchedAt < OPENAI_MODELS_TTL_MS;
  if (fresh && openaiModelsCache.models) return openaiModelsCache.models;

  try {
    const tokens = await getOAuthTokens('openai');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
    const url = `${OPENAI_MODELS_URL}?client_version=${encodeURIComponent(CODEX_CLI_VERSION)}`;
    const response = await fetch(url, {
      headers: {
        'authorization': `Bearer ${tokens.accessToken}`,
        'originator': 'codex_cli_rs',
        'user-agent': CODEX_CLI_UA,
        'version': CODEX_CLI_VERSION,
        ...(tokens.accountId && { 'chatgpt-account-id': tokens.accountId }),
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const models = (data.models || [])
      .filter(m => m.slug)
      .map(m => ({ id: m.slug, name: m.display_name || m.slug }));
    if (models.length === 0) throw new Error('empty catalog');

    openaiModelsCache = { fetchedAt: Date.now(), models };
    console.log(`[MODELS] OpenAI catalog refreshed (client_version=${CODEX_CLI_VERSION}): ${models.map(m => m.id).join(', ')}`);
    return models;
  } catch (e) {
    console.warn(`[MODELS] OpenAI catalog fetch failed (${e.message}), falling back to static list`);
    // Serve a stale cache over the static list — it was real at some point.
    return openaiModelsCache.models || OPENAI_MODELS;
  }
}

// ─── Live Anthropic model discovery ───
// Same reasoning as the OpenAI side: the static list goes stale silently. It sat
// at 4.6 while the account could already serve the 5 family, so /v1/models
// advertised a catalog a whole generation behind what actually worked.
const ANTHROPIC_MODELS_TTL_MS = 60 * 60 * 1000;  // 1h
let anthropicModelsCache = { fetchedAt: 0, models: null };

async function fetchAnthropicModels() {
  const fresh = Date.now() - anthropicModelsCache.fetchedAt < ANTHROPIC_MODELS_TTL_MS;
  if (fresh && anthropicModelsCache.models) return anthropicModelsCache.models;

  try {
    const tokens = await getOAuthTokens('anthropic');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
    const response = await fetch(`${ANTHROPIC_MODELS_URL}?limit=100`, {
      headers: {
        'authorization': `Bearer ${tokens.accessToken}`,
        'anthropic-version': ANTHROPIC_API_VERSION,
        'anthropic-beta': ANTHROPIC_OAUTH_BETA,
        'user-agent': `claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`,
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const models = (data.data || [])
      .filter(m => m.id)
      .map(m => ({ id: m.id, name: m.display_name || m.id }));
    if (models.length === 0) throw new Error('empty catalog');

    anthropicModelsCache = { fetchedAt: Date.now(), models };
    console.log(`[MODELS] Anthropic catalog refreshed: ${models.map(m => m.id).join(', ')}`);
    return models;
  } catch (e) {
    console.warn(`[MODELS] Anthropic catalog fetch failed (${e.message}), falling back to static list`);
    return anthropicModelsCache.models || ANTHROPIC_MODELS;
  }
}

// ═══════════════════════════════════════════════════════════════
// §2  Auth File Management (dual-section)
// ═══════════════════════════════════════════════════════════════

function loadAuthFile() {
  try {
    if (!existsSync(AUTH_FILE)) return {};
    return JSON.parse(readFileSync(AUTH_FILE, 'utf8'));
  } catch (e) {
    console.error(`[AUTH] Error reading ${AUTH_FILE}: ${e.message}`);
    return {};
  }
}

function saveAuthFile(data) {
  try {
    mkdirSync(dirname(AUTH_FILE), { recursive: true });
    // Write to a temp file in the same directory, then rename. rename(2) is
    // atomic within a filesystem, so a crash mid-write can never leave a
    // truncated auth.json — which would lose *both* providers' tokens and
    // force a re-login.
    const tmp = `${AUTH_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, AUTH_FILE);
  } catch (e) {
    console.error(`[AUTH] Error writing ${AUTH_FILE}: ${e.message}`);
  }
}

/**
 * Migrate legacy auth.json formats to dual-section format.
 * 1. Flat format: { accessToken, refreshToken, expiresAt } → { anthropic: {...} }
 * 2. Old location: ~/.claude-max-proxy/auth.json → copy to new location
 */
function migrateAuthFileIfNeeded() {
  // Check old location fallback
  if (!existsSync(AUTH_FILE)) {
    const oldPath = join(homedir(), '.claude-max-proxy', 'auth.json');
    if (existsSync(oldPath)) {
      console.log(`[AUTH MIGRATION] Found legacy auth file at ${oldPath}`);
      try {
        const oldData = JSON.parse(readFileSync(oldPath, 'utf8'));
        mkdirSync(dirname(AUTH_FILE), { recursive: true });
        // Migrate format if flat
        if (oldData.accessToken && !oldData.anthropic) {
          const migrated = { anthropic: { accessToken: oldData.accessToken, refreshToken: oldData.refreshToken, expiresAt: oldData.expiresAt } };
          writeFileSync(AUTH_FILE, JSON.stringify(migrated, null, 2), { mode: 0o600 });
          console.log(`[AUTH MIGRATION] Migrated flat format → dual-section at ${AUTH_FILE}`);
        } else {
          writeFileSync(AUTH_FILE, JSON.stringify(oldData, null, 2), { mode: 0o600 });
          console.log(`[AUTH MIGRATION] Copied to ${AUTH_FILE}`);
        }
      } catch (e) {
        console.error(`[AUTH MIGRATION] Error: ${e.message}`);
      }
      return;
    }
  }

  // Migrate in-place if flat format
  const data = loadAuthFile();
  if (!data || Object.keys(data).length === 0) return;
  if (data.anthropic || data.openai) return; // Already dual-section
  if (data.accessToken) {
    console.log('[AUTH MIGRATION] Detected legacy flat auth.json → migrating to dual-section');
    const migrated = { anthropic: { accessToken: data.accessToken, refreshToken: data.refreshToken, expiresAt: data.expiresAt } };
    saveAuthFile(migrated);
    console.log('[AUTH MIGRATION] Done. Anthropic credentials preserved.');
  }
}

// ═══════════════════════════════════════════════════════════════
// §3  Token Management (per-provider)
// ═══════════════════════════════════════════════════════════════

function loadTokensForProvider(provider) {
  const data = loadAuthFile();
  if (data[provider]?.accessToken) return data[provider];

  // Anthropic-specific fallbacks (env var, CLI credentials, Keychain)
  if (provider === 'anthropic') {
    const envToken = process.env.CLAUDE_ACCESS_TOKEN;
    if (envToken) return { accessToken: envToken, expiresAt: Date.now() + 86400000 };

    try {
      const legacyFile = join(homedir(), '.claude', '.credentials.json');
      if (existsSync(legacyFile)) {
        const legacyData = JSON.parse(readFileSync(legacyFile, 'utf8'));
        if (legacyData.claudeAiOauth?.accessToken) return legacyData.claudeAiOauth;
      }
    } catch (e) {}

    if (process.platform === 'darwin') {
      try {
        const output = execSync('security find-generic-password -s "Claude Code-credentials" -w', { encoding: 'utf8', timeout: 5000 }).trim();
        const keychainData = JSON.parse(output);
        if (keychainData.claudeAiOauth?.accessToken) return keychainData.claudeAiOauth;
      } catch (e) {}
    }
  }

  // OpenAI-specific fallbacks (env vars)
  if (provider === 'openai') {
    const envToken = process.env.OPENAI_ACCESS_TOKEN;
    if (envToken) {
      return {
        accessToken: envToken,
        accountId: process.env.OPENAI_ACCOUNT_ID || null,
        expiresAt: Date.now() + 86400000,
      };
    }
  }

  return null;
}

function saveTokensForProvider(tokens, provider) {
  const data = loadAuthFile();
  data[provider] = { ...data[provider], ...tokens };  // merge: preserve accountId across refreshes
  saveAuthFile(data);
}

async function getOAuthTokens(provider = 'anthropic') {
  if (cachedTokens[provider] && Date.now() < tokenExpiry[provider] - 300000) {
    return cachedTokens[provider];
  }

  let oauth = loadTokensForProvider(provider);
  if (!oauth?.accessToken) {
    const loginCmd = provider === 'anthropic' ? '--login' : `--login ${provider}`;
    throw new Error(`No ${provider} OAuth tokens found. Run "node server.js ${loginCmd}" on the host to authorize.`);
  }

  // Auto-refresh if within 5 min of expiry or already expired
  if (oauth.expiresAt && Date.now() >= oauth.expiresAt - 300000 && oauth.refreshToken) {
    const refreshed = await doRefreshToken(oauth.refreshToken, provider);
    if (refreshed) {
      saveTokensForProvider(refreshed, provider);
      cachedTokens[provider] = refreshed;
      tokenExpiry[provider] = refreshed.expiresAt;
      return refreshed;
    }
    const loginCmd = provider === 'anthropic' ? '--login' : `--login ${provider}`;
    console.error(`[${provider.toUpperCase()} TOKEN] Refresh failed, using expired token. Re-run "node server.js ${loginCmd}".`);
  }

  // Token health logging
  const now = Date.now();
  if (oauth.expiresAt && now >= oauth.expiresAt) {
    const expiredAgo = ((now - oauth.expiresAt) / 3600000).toFixed(1);
    console.error(`[${provider.toUpperCase()} TOKEN EXPIRED] ${expiredAgo}h ago.`);
  } else if (oauth.expiresAt && oauth.expiresAt - now < 1800000) {
    const minsLeft = ((oauth.expiresAt - now) / 60000).toFixed(0);
    console.warn(`[${provider.toUpperCase()} TOKEN WARNING] Expires in ${minsLeft} min.`);
  }

  cachedTokens[provider] = oauth;
  tokenExpiry[provider] = oauth.expiresAt || Date.now() + 3600000;
  return oauth;
}

// Refresh state per provider, surfaced on /health so a broken refresh chain is
// visible instead of silent. A dead provider used to be invisible: /health still
// reported "ok" as long as the *other* provider was alive.
const refreshState = {
  anthropic: { consecutiveFailures: 0, lastError: null, lastFailureAt: null, lastSuccessAt: null },
  openai:    { consecutiveFailures: 0, lastError: null, lastFailureAt: null, lastSuccessAt: null },
};

// In-flight refresh per provider. Both the background loop and the request path
// can trigger a refresh; without this they race, each POSTing the same rolling
// refresh token. The loser gets "Refresh token not found or invalid", and a
// server implementing reuse detection may revoke the whole token family.
const inFlightRefresh = {};

function noteRefreshSuccess(provider) {
  const s = refreshState[provider];
  if (s.consecutiveFailures > 0) {
    console.log(`[${provider.toUpperCase()} TOKEN REFRESH] Recovered after ${s.consecutiveFailures} failure(s)`);
    sendAlert(`${provider} token refresh recovered after ${s.consecutiveFailures} failure(s).`);
  }
  s.consecutiveFailures = 0;
  s.lastError = null;
  s.lastSuccessAt = Date.now();
}

function noteRefreshFailure(provider, error) {
  const s = refreshState[provider];
  s.consecutiveFailures += 1;
  s.lastError = error;
  s.lastFailureAt = Date.now();
  // Alert on the first failure, then back off geometrically. The old behaviour
  // logged ~2000 identical failures over six weeks and told nobody.
  const n = s.consecutiveFailures;
  if (n === 1 || n === 5 || n === 20 || (n % 100 === 0)) {
    sendAlert(
      `${provider} token refresh FAILED ${n}x (latest: ${error}). ` +
      `Re-authenticate with "node server.js --login ${provider}".`
    );
  }
}

// Optional outbound alert. Fire-and-forget: alerting must never break serving.
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || '';
function sendAlert(message) {
  console.error(`[ALERT] ${message}`);
  if (!ALERT_WEBHOOK_URL) return;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 5000);
  fetch(ALERT_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `[unified-proxy] ${message}` }),
    signal: controller.signal,
  }).catch(e => console.error(`[ALERT] Webhook delivery failed: ${e.message}`));
}

function doRefreshToken(refreshTok, provider = 'anthropic') {
  // Coalesce: a concurrent caller joins the running refresh instead of starting
  // a second one with the same (single-use) token.
  if (inFlightRefresh[provider]) {
    console.log(`[${provider.toUpperCase()} TOKEN REFRESH] Already in flight, joining it`);
    return inFlightRefresh[provider];
  }
  const promise = doRefreshTokenUncoalesced(refreshTok, provider)
    .finally(() => { delete inFlightRefresh[provider]; });
  inFlightRefresh[provider] = promise;
  return promise;
}

async function doRefreshTokenUncoalesced(refreshTok, provider = 'anthropic') {
  const tokenUrl = provider === 'openai' ? OPENAI_TOKEN_URL : ANTHROPIC_TOKEN_URL;
  const clientId = provider === 'openai' ? OPENAI_CLIENT_ID : ANTHROPIC_CLIENT_ID;

  // Bound the request. Without this a hung connection stalls the background
  // refresh loop indefinitely.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);

  try {
    console.log(`[${provider.toUpperCase()} TOKEN REFRESH] Attempting...`);

    let response;
    if (provider === 'openai') {
      // OpenAI uses application/x-www-form-urlencoded
      const params = new URLSearchParams();
      params.set('grant_type', 'refresh_token');
      params.set('refresh_token', refreshTok);
      params.set('client_id', clientId);
      params.set('scope', OPENAI_SCOPE_REFRESH);
      response = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
        signal: controller.signal,
      });
    } else {
      // Anthropic uses application/json
      response = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshTok, client_id: clientId }),
        signal: controller.signal,
      });
    }

    if (!response.ok) {
      const err = await response.text();
      console.error(`[${provider.toUpperCase()} TOKEN REFRESH FAILED] Status ${response.status}: ${err}`);
      noteRefreshFailure(provider, `HTTP ${response.status}: ${err.slice(0, 200)}`);
      return null;
    }
    const data = await response.json();
    console.log(`[${provider.toUpperCase()} TOKEN REFRESH] Success, valid for ${(data.expires_in / 3600).toFixed(1)}h`);
    noteRefreshSuccess(provider);
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshTok,
      expiresAt: Date.now() + (data.expires_in * 1000),
    };
  } catch (e) {
    // An aborted request is ambiguous: the server may have consumed and rotated
    // the token before we gave up, in which case our stored copy is now dead.
    const detail = e.name === 'AbortError' ? `timed out after ${REFRESH_TIMEOUT_MS}ms` : e.message;
    console.error(`[${provider.toUpperCase()} TOKEN REFRESH ERROR] ${detail}`);
    noteRefreshFailure(provider, detail);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ═══════════════════════════════════════════════════════════════
// §4  Anthropic Format Conversion (existing logic preserved)
// ═══════════════════════════════════════════════════════════════

function buildToolContext(tools, systemPrompts) {
  let context = '';
  if (systemPrompts && systemPrompts.length > 0) {
    context += '[Assistant Identity]\n' + systemPrompts.join('\n') + '\n\n';
  }
  if (tools && tools.length > 0) {
    const defs = tools.map(t => {
      const fn = t.function || t;
      return `- ${fn.name}: ${fn.description || 'No description'}`;
    }).join('\n');
    context += '[Available Tools]\n' + defs + '\n\n[Tool Usage]\nWhen you need to use a tool, output XML:\n<function_calls>\n<invoke name="TOOL_NAME">\n<parameter name="PARAM">VALUE</parameter>\n</invoke>\n</function_calls>\nDo NOT show the XML to the user or explain it. Just use it silently.\n\n';
  }
  return context;
}

function parseXmlToolCalls(text) {
  const toolCalls = [];
  const regex = /<function_calls>([\s\S]*?)<\/function_calls>/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const invokeRegex = /<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>/g;
    let invokeMatch;
    while ((invokeMatch = invokeRegex.exec(match[1])) !== null) {
      const params = {};
      const paramRegex = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g;
      let paramMatch;
      while ((paramMatch = paramRegex.exec(invokeMatch[2])) !== null) {
        params[paramMatch[1]] = paramMatch[2];
      }
      toolCalls.push({
        id: 'call_' + randomUUID().split('-')[0],
        type: 'function',
        function: { name: invokeMatch[1], arguments: JSON.stringify(params) }
      });
    }
  }
  const cleanText = text.replace(/<function_calls>[\s\S]*?<\/function_calls>/g, '').trim();
  return { toolCalls, cleanText };
}

function toolCallsToXml(toolCalls) {
  if (!toolCalls || toolCalls.length === 0) return '';
  let xml = '<function_calls>\n';
  for (const call of toolCalls) {
    const fn = call.function;
    let args = {};
    try { args = JSON.parse(fn.arguments || '{}'); } catch (e) {}
    xml += `<invoke name="${fn.name}">\n`;
    for (const [key, value] of Object.entries(args)) {
      xml += `<parameter name="${key}">${value}</parameter>\n`;
    }
    xml += '</invoke>\n';
  }
  xml += '</function_calls>';
  return xml;
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  return content?.text || '';
}

/**
 * Convert a Chat Completions image_url block to an Anthropic image block.
 * Remote URLs use the url source; data: URIs are split into media_type + base64.
 * Returns null when the block carries no usable URL.
 */
function toAnthropicImage(spec) {
  const url = typeof spec === 'string' ? spec : spec?.url;
  if (!url) return null;
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
  return { type: 'image', source: { type: 'url', url } };
}

/**
 * Build user-message content for the Anthropic API.
 * Returns a plain string when no image is present — keeping the long-standing
 * text-only behaviour byte-identical — and a content block array only when one
 * is. extractText() used to filter image_url blocks out entirely, so images were
 * silently dropped and Claude replied "I don't see an image".
 */
function buildAnthropicContent(content) {
  if (!Array.isArray(content)) return extractText(content);
  if (!content.some(c => c?.type === 'image_url')) return extractText(content);

  const blocks = [];
  for (const part of content) {
    if (part.type === 'text' && part.text) {
      blocks.push({ type: 'text', text: part.text });
    } else if (part.type === 'image_url') {
      const img = toAnthropicImage(part.image_url);
      if (img) blocks.push(img);
    }
  }
  return blocks.length > 0 ? blocks : '';
}

/** Join two message contents, either of which may be a string or a block array. */
function mergeContent(a, b) {
  if (typeof a === 'string' && typeof b === 'string') return a + '\n\n' + b;
  const toBlocks = (c) => (typeof c === 'string' ? [{ type: 'text', text: c }] : c);
  return [...toBlocks(a), ...toBlocks(b)];
}

/** Prepend text to a message content that may be a string or a block array. */
function prependText(content, text) {
  if (typeof content === 'string') return text + content;
  return [{ type: 'text', text }, ...content];
}

function convertMessages(messages, tools) {
  let systemPrompts = [];
  const anthropicMessages = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemPrompts.push(extractText(msg.content));
    } else if (msg.role === 'user') {
      const content = buildAnthropicContent(msg.content);
      if (typeof content === 'string' ? content : content.length > 0) {
        anthropicMessages.push({ role: 'user', content });
      }
    } else if (msg.role === 'assistant') {
      let content = extractText(msg.content);
      if ((!content || content.trim() === '' || content === '[Using tools...]') && msg.tool_calls && msg.tool_calls.length > 0) {
        content = toolCallsToXml(msg.tool_calls);
      }
      if (content && content.trim()) {
        anthropicMessages.push({ role: 'assistant', content });
      }
    } else if (msg.role === 'tool') {
      const content = `[Tool Result: ${msg.tool_call_id}]\n${extractText(msg.content)}`;
      anthropicMessages.push({ role: 'user', content });
    }
  }

  // Merge consecutive same-role messages
  const fixedMessages = [];
  for (const msg of anthropicMessages) {
    if (fixedMessages.length > 0 && fixedMessages[fixedMessages.length - 1].role === msg.role) {
      const last = fixedMessages[fixedMessages.length - 1];
      last.content = mergeContent(last.content, msg.content);
    } else {
      fixedMessages.push(msg);
    }
  }

  // Inject tool context into first user message
  const toolContext = buildToolContext(tools, systemPrompts);
  if (toolContext && fixedMessages.length > 0) {
    for (let i = 0; i < fixedMessages.length; i++) {
      if (fixedMessages[i].role === 'user') {
        fixedMessages[i].content = prependText(fixedMessages[i].content, toolContext + '[User Message]\n');
        break;
      }
    }
  }

  return { system: CLAUDE_CODE_SYSTEM, messages: fixedMessages };
}

// ═══════════════════════════════════════════════════════════════
// §5  Anthropic Chat Handler (existing logic preserved)
// ═══════════════════════════════════════════════════════════════

async function handleAnthropicChat(req, res, body) {
  const { model, messages, max_tokens, tools, stream, thinking } = body;
  const mappedModel = resolveAnthropicModel(model);
  const { system, messages: anthropicMessages } = convertMessages(messages, tools);
  const hasTools = tools && tools.length > 0;

  console.log(`[ANTHROPIC ${stream ? 'STREAM' : 'SYNC'}] model=${mappedModel}, tools=${tools?.length || 0}, msgs=${anthropicMessages.length}`);

  const requestId = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  let tokens;
  try { tokens = await getOAuthTokens('anthropic'); }
  catch (e) { return sendJSON(res, 503, { error: { message: e.message, type: 'provider_unavailable' } }); }

  const apiUrl = new URL(ANTHROPIC_API_URL);
  apiUrl.searchParams.set('beta', 'true');
  const apiUrlStr = apiUrl.toString();

  const apiHeaders = {
    'Authorization': `Bearer ${tokens.accessToken}`,
    'Content-Type': 'application/json',
    'anthropic-version': ANTHROPIC_API_VERSION,
    'anthropic-beta': `${ANTHROPIC_OAUTH_BETA},interleaved-thinking-2025-05-14,prompt-caching-2024-07-31`,
    'user-agent': `claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`,
  };

  // Enable prompt caching: wrap system as array with cache_control
  const systemWithCache = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];

  // Mark last historical message (second-to-last overall) as a cache breakpoint
  // so repeated conversation prefixes are cached across multi-turn requests
  if (anthropicMessages.length > 1) {
    const lastHistory = anthropicMessages[anthropicMessages.length - 2];
    if (typeof lastHistory.content === 'string') {
      lastHistory.content = [{ type: 'text', text: lastHistory.content, cache_control: { type: 'ephemeral' } }];
    }
  }

  const requestBody = {
    model: mappedModel,
    system: systemWithCache,
    messages: anthropicMessages,
    max_tokens: max_tokens || 8192,
  };
  // temperature is never forwarded. Claude 4-7 and newer reject every value but
  // the default 1 ("`temperature` is deprecated for this model"), and OpenAI
  // clients send the field unconditionally — often with no way to turn it off —
  // so honouring it turned every such request into a 400. Dropping it is lossless
  // there (an absent field already means 1) and matches the OpenAI path, which
  // drops the sampling params silently for the same reason.
  if (thinking) {
    requestBody.thinking = thinking;
  }

  // For tool requests, use sync to ensure XML is filtered before sending
  if (stream && !hasTools) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    try {
      const response = await fetch(apiUrlStr, {
        method: 'POST',
        headers: apiHeaders,
        body: JSON.stringify({ ...requestBody, stream: true }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error('[ANTHROPIC API ERROR]', response.status, error);
        res.write(`data: ${JSON.stringify({ error: { message: error } })}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            const event = JSON.parse(data);
            if (event.type === 'content_block_delta' && event.delta?.text) {
              res.write(`data: ${JSON.stringify({
                id: requestId, object: 'chat.completion.chunk', created, model,
                choices: [{ index: 0, delta: { content: event.delta.text }, finish_reason: null }]
              })}\n\n`);
            } else if (event.type === 'message_stop') {
              res.write(`data: ${JSON.stringify({
                id: requestId, object: 'chat.completion.chunk', created, model,
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
              })}\n\n`);
            }
          } catch (e) {}
        }
      }
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (e) {
      console.error('[ANTHROPIC STREAM ERROR]', e.message);
      res.write(`data: ${JSON.stringify({ error: { message: e.message } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  } else {
    // Sync mode for tool requests
    try {
      const response = await fetch(apiUrlStr, {
        method: 'POST',
        headers: apiHeaders,
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error('[ANTHROPIC API ERROR]', response.status, error);
        return sendJSON(res, response.status, { error: { message: error } });
      }

      const data = await response.json();
      const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
      const { toolCalls, cleanText } = parseXmlToolCalls(text);

      const finalContent = cleanText || (toolCalls.length > 0 ? null : 'Done.');
      const message = { role: 'assistant', content: finalContent };
      if (toolCalls.length > 0) message.tool_calls = toolCalls;

      if (stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });

        if (finalContent) {
          res.write(`data: ${JSON.stringify({
            id: requestId, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { content: finalContent }, finish_reason: null }]
          })}\n\n`);
        }

        if (toolCalls.length > 0) {
          res.write(`data: ${JSON.stringify({
            id: requestId, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: 'tool_calls' }]
          })}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify({
            id: requestId, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
          })}\n\n`);
        }

        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        sendJSON(res, 200, {
          id: requestId, object: 'chat.completion', created, model,
          choices: [{ index: 0, message, finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: data.usage?.input_tokens || -1, completion_tokens: data.usage?.output_tokens || -1, total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0) },
        });
      }
    } catch (e) {
      console.error('[ANTHROPIC ERROR]', e.message);
      sendJSON(res, 500, { error: { message: e.message } });
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// §5b  ChatGPT Backend: Request Conversion (Chat Completions → Codex Responses)
// ═══════════════════════════════════════════════════════════════

/**
 * Convert OpenAI Chat Completions request body to Codex Responses format.
 * Returns { error, codexBody } — if error is set, caller should return 400.
 */
function convertToCodexRequest(body) {
  const { messages, model, tools, tool_choice, stop, n, reasoning_effort } = body;

  // Reject unsupported parameters
  if (stop !== undefined) {
    return { error: { message: 'Parameter "stop" is not supported by the ChatGPT Backend (Responses API does not support stop sequences).', type: 'unsupported_parameter', param: 'stop' } };
  }
  if (n !== undefined && n !== 1) {
    return { error: { message: 'Parameter "n" > 1 is not supported by the ChatGPT Backend (Responses API does not support multiple choices).', type: 'unsupported_parameter', param: 'n' } };
  }

  // Extract instructions from system messages, build input from the rest
  const instructions = [];
  const input = [];

  for (const msg of (messages || [])) {
    switch (msg.role) {
      case 'system':
      case 'developer':
        instructions.push(extractTextContent(msg.content));
        break;
      case 'user': {
        const content = buildUserContent(msg.content);
        if (content.length > 0) {
          input.push({
            type: 'message',
            role: 'user',
            content,
          });
        }
        break;
      }
      case 'assistant': {
        const text = extractTextContent(msg.content);
        if (text) {
          input.push({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text }],
          });
        }
        // Convert tool_calls to function_call items
        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            const fn = tc.function || {};
            input.push({
              type: 'function_call',
              name: fn.name || '',
              call_id: tc.id || '',
              arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {}),
            });
          }
        }
        break;
      }
      case 'tool': {
        if (!msg.tool_call_id) break;
        const output = typeof msg.content === 'string' ? msg.content : extractTextContent(msg.content);
        input.push({
          type: 'function_call_output',
          call_id: msg.tool_call_id,
          output: output || '',
        });
        break;
      }
    }
  }

  // `input` is required upstream. Catch an empty one here — otherwise we ship a
  // malformed request and the backend answers with a misleading
  // "Missing required parameter: 'input'" that points at the wrong layer.
  if (input.length === 0) {
    return { error: { message: 'No usable content in "messages": every non-system message was empty or contained only unsupported content blocks.', type: 'invalid_request_error', param: 'messages' } };
  }

  // Build Codex request body
  const codexBody = {
    model: stripPrefix(model),
    store: false,
    stream: true,
  };

  // instructions is required by the ChatGPT Backend even if empty
  codexBody.instructions = instructions.length > 0 ? instructions.join('\n\n') : '';
  codexBody.input = input;

  // Prompt caching: derive a deterministic session ID from instructions content.
  // Same instructions → same session ID → ChatGPT Backend can reuse cached prefix.
  const hash = createHash('sha256').update(codexBody.instructions).digest('hex');
  // Format as UUID v4 (set version=4 nibble and variant bits)
  const sessionId = [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '4' + hash.slice(13, 16),           // version 4
    ((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16) + hash.slice(17, 20), // variant 10xx
    hash.slice(20, 32),
  ].join('-');
  codexBody.prompt_cache_key = sessionId;

  // Sampling parameters — temperature, top_p, and max_tokens are not supported
  // by the ChatGPT Backend Codex Responses API and are silently dropped.
  if (reasoning_effort !== undefined) codexBody.reasoning = { effort: reasoning_effort };

  // Tools mapping
  if (tools && Array.isArray(tools) && tools.length > 0) {
    codexBody.tools = tools.filter(t => t.type === 'function' && t.function).map(t => ({
      type: 'function',
      name: t.function.name,
      description: t.function.description || '',
      strict: false,
      parameters: t.function.parameters,
    }));
  }

  // Tool choice normalization
  if (tool_choice !== undefined) {
    if (typeof tool_choice === 'string') {
      codexBody.tool_choice = tool_choice;
    } else if (tool_choice?.type === 'function' && tool_choice?.function?.name) {
      codexBody.tool_choice = { type: 'function', name: tool_choice.function.name };
    } else {
      codexBody.tool_choice = tool_choice;
    }
  }

  return { codexBody };
}

/**
 * Extract text from string or array content (Chat Completions format).
 * Non-text blocks are skipped: this feeds roles where the Responses API takes
 * plain text only (system/developer/assistant/tool), so an image alongside the
 * text must not cost us the text.
 */
function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = [];
    for (const part of content) {
      if (part.type === 'text' && part.text) {
        texts.push(part.text);
      }
    }
    return texts.join('\n') || null;
  }
  return null;
}

/**
 * Build Responses-API content blocks for a user message.
 * Chat Completions `text` → `input_text`, `image_url` → `input_image`.
 * Accepts both `image_url: "https://…"` and `image_url: { url, detail }`;
 * remote URLs and data: URIs are passed through untouched.
 * Returns [] when the message carries nothing usable.
 */
function buildUserContent(content) {
  if (typeof content === 'string') {
    return content ? [{ type: 'input_text', text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const blocks = [];
  for (const part of content) {
    if (part.type === 'text' && part.text) {
      blocks.push({ type: 'input_text', text: part.text });
    } else if (part.type === 'image_url') {
      const spec = part.image_url;
      const url = typeof spec === 'string' ? spec : spec?.url;
      if (!url) continue;
      const block = { type: 'input_image', image_url: url };
      const detail = typeof spec === 'object' ? spec?.detail : undefined;
      if (detail) block.detail = detail;
      blocks.push(block);
    }
  }
  return blocks;
}

// ═══════════════════════════════════════════════════════════════
// §5c  ChatGPT Backend: SSE Response Conversion (Codex Responses → Chat Completions)
// ═══════════════════════════════════════════════════════════════

class CodexSSETransformer {
  constructor(model) {
    this.model = model;
    this.responseID = `chatcmpl-${randomUUID()}`;
    this.roleSent = false;
    this.toolIndexByItemID = new Map();  // fc_* → index
    this.toolIDByItemID = new Map();     // fc_* → call_id
    this.nextToolIndex = 0;
    this.sawToolCalls = false;
    this.usage = null;
  }

  /** Build a role-only chunk (emitted once at start of response). */
  _roleChunk(created) {
    if (this.roleSent) return null;
    this.roleSent = true;
    return {
      id: this.responseID, object: 'chat.completion.chunk', created, model: this.model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    };
  }

  /**
   * Transform a single Codex SSE JSON event into Chat Completions chunk(s).
   * Returns array of chunk objects (may be empty), or { done: true }.
   */
  transform(event) {
    const type = event.type;
    const created = event.sequence_number || Math.floor(Date.now() / 1000);
    const chunks = [];

    switch (type) {
      case 'response.created': {
        const resp = event.response;
        if (resp?.id) this.responseID = 'chatcmpl-' + resp.id;
        // Emit role chunk
        const rc = this._roleChunk(created);
        if (rc) chunks.push(rc);
        break;
      }

      case 'response.output_text.delta': {
        const rc = this._roleChunk(created);
        if (rc) chunks.push(rc);
        chunks.push({
          id: this.responseID, object: 'chat.completion.chunk', created, model: this.model,
          choices: [{ index: 0, delta: { content: event.delta || '' }, finish_reason: null }],
        });
        break;
      }

      case 'response.output_item.added': {
        const item = event.item;
        if (!item || item.type !== 'function_call') break;
        this.sawToolCalls = true;

        const fcID = item.id || '';
        const callID = item.call_id || ('call_' + fcID);
        const name = item.name || '';
        const idx = this.nextToolIndex++;
        this.toolIndexByItemID.set(fcID, idx);
        this.toolIDByItemID.set(fcID, callID);

        const rc = this._roleChunk(created);
        if (rc) chunks.push(rc);
        chunks.push({
          id: this.responseID, object: 'chat.completion.chunk', created, model: this.model,
          choices: [{ index: 0, delta: {
            tool_calls: [{ index: idx, id: callID, type: 'function', function: { name, arguments: '' } }],
          }, finish_reason: null }],
        });
        break;
      }

      case 'response.function_call_arguments.delta': {
        const itemID = event.item_id || '';
        const idx = this.toolIndexByItemID.get(itemID);
        if (idx === undefined) break;

        const rc = this._roleChunk(created);
        if (rc) chunks.push(rc);
        chunks.push({
          id: this.responseID, object: 'chat.completion.chunk', created, model: this.model,
          choices: [{ index: 0, delta: {
            tool_calls: [{ index: idx, function: { arguments: event.delta || '' } }],
          }, finish_reason: null }],
        });
        break;
      }

      case 'response.completed': {
        // Determine finish_reason
        let finish_reason = 'stop';
        if (this.sawToolCalls) {
          finish_reason = 'tool_calls';
        } else {
          const resp = event.response;
          if (resp?.status === 'incomplete' || resp?.incomplete_details?.reason === 'max_output_tokens') {
            finish_reason = 'length';
          }
        }

        // Extract usage — preserve prompt_tokens_details/completion_tokens_details for caching visibility
        const respUsage = event.response?.usage;
        if (respUsage) {
          const prompt_tokens = respUsage.input_tokens ?? respUsage.prompt_tokens ?? 0;
          const completion_tokens = respUsage.output_tokens ?? respUsage.completion_tokens ?? 0;
          this.usage = { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens };
          if (respUsage.prompt_tokens_details) this.usage.prompt_tokens_details = respUsage.prompt_tokens_details;
          if (respUsage.completion_tokens_details) this.usage.completion_tokens_details = respUsage.completion_tokens_details;
          // Also check Responses API field names (input_tokens_details / output_tokens_details)
          if (respUsage.input_tokens_details) this.usage.prompt_tokens_details = { cached_tokens: respUsage.input_tokens_details.cached_tokens ?? 0 };
          if (respUsage.output_tokens_details) this.usage.completion_tokens_details = { reasoning_tokens: respUsage.output_tokens_details.reasoning_tokens ?? 0 };
        } else {
          this.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        }

        const finalChunk = {
          id: this.responseID, object: 'chat.completion.chunk', created, model: this.model,
          choices: [{ index: 0, delta: {}, finish_reason }],
          usage: this.usage,
        };
        chunks.push(finalChunk);
        break;
      }

      // Ignore all other event types
      default:
        break;
    }

    return chunks;
  }
}

// ═══════════════════════════════════════════════════════════════
// §6  OpenAI Chat Handler (ChatGPT Backend — Codex Responses conversion)
// ═══════════════════════════════════════════════════════════════

async function handleOpenAIChat(req, res, body) {
  const { model, stream } = body;
  const bareModel = stripPrefix(model);

  console.log(`[OPENAI ${stream ? 'STREAM' : 'SYNC'}] model=${bareModel}, msgs=${body.messages?.length || 0}, tools=${body.tools?.length || 0}`);

  // 1. Convert Chat Completions → Codex Responses format.
  //    Done before auth so a bad request reports as 400, not as whatever the
  //    token state happens to be.
  const { error: convError, codexBody } = convertToCodexRequest(body);
  if (convError) {
    return sendJSON(res, 400, { error: convError });
  }

  // 2. Get OAuth tokens
  let tokens;
  try { tokens = await getOAuthTokens('openai'); }
  catch (e) { return sendJSON(res, 503, { error: { message: e.message, type: 'provider_unavailable' } }); }

  // 3. accountId is optional — the ChatGPT backend accepts requests without the
  //    chatgpt-account-id header, so a missing one must not block the request.
  if (!tokens.accountId) {
    console.warn('[OPENAI] No accountId stored; sending request without chatgpt-account-id header.');
  }

  console.log(`[OPENAI] → ChatGPT Backend: model=${codexBody.model}, input=${codexBody.input?.length || 0}, tools=${codexBody.tools?.length || 0}, cache_key=${codexBody.prompt_cache_key}`);

  // 4. Make upstream request (with 401 retry)
  const makeUpstreamRequest = async (tok) => {
    const controller = new AbortController();
    const connectTimer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);

    const response = await fetch(OPENAI_CHATGPT_BACKEND_URL, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${tok.accessToken}`,
        'content-type': 'application/json',
        'accept': 'text/event-stream',
        ...(tok.accountId && { 'chatgpt-account-id': tok.accountId }),
        'openai-beta': 'responses=experimental',
        'originator': 'codex_cli_rs',
        'session_id': codexBody.prompt_cache_key,
        'user-agent': CODEX_CLI_UA,
        'version': CODEX_CLI_VERSION,
      },
      body: JSON.stringify(codexBody),
      signal: controller.signal,
    });
    clearTimeout(connectTimer);
    return response;
  };

  try {
    let response = await makeUpstreamRequest(tokens);

    // 401 → refresh + retry once
    if (response.status === 401) {
      console.warn('[OPENAI] Upstream 401, attempting token refresh...');
      try { await response.text(); } catch {}  // drain body
      const refreshed = await doRefreshToken(tokens.refreshToken, 'openai');
      if (refreshed) {
        saveTokensForProvider(refreshed, 'openai');
        cachedTokens.openai = refreshed;
        tokenExpiry.openai = refreshed.expiresAt;
        // Re-read tokens to get merged data (with accountId preserved)
        tokens = loadTokensForProvider('openai');
        if (tokens) {
          console.log('[OPENAI] Token refreshed, retrying...');
          response = await makeUpstreamRequest(tokens);
        }
      }
      if (response.status === 401) {
        return sendJSON(res, 503, { error: {
          message: 'OpenAI authentication failed after refresh. Re-run "node server.js --login openai".',
          type: 'provider_unavailable',
        } });
      }
    }

    // Non-200 error handling
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[OPENAI API ERROR] ${response.status}: ${errorText}`);
      return sendJSON(res, response.status >= 500 ? 502 : response.status, {
        error: { message: errorText, type: 'upstream_error' },
      });
    }

    // 5. Process SSE response from ChatGPT Backend
    const transformer = new CodexSSETransformer(bareModel);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';

    if (stream) {
      // ── Streaming mode: forward converted chunks to client ──
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          sseBuffer += decoder.decode(value, { stream: true });
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(':')) continue;
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === '[DONE]') continue;

            try {
              const event = JSON.parse(payload);
              const chunks = transformer.transform(event);
              for (const chunk of chunks) {
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              }
            } catch {}
          }
        }
        res.write('data: [DONE]\n\n');
        res.end();
      } catch (e) {
        console.error('[OPENAI STREAM ERROR]', e.message);
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ error: { message: e.message } })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }
    } else {
      // ── Non-streaming mode: buffer all chunks, aggregate into single JSON ──
      try {
        let contentParts = [];
        let toolCallsMap = new Map();  // index → { id, type, function: { name, arguments } }
        let finishReason = 'stop';
        let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          sseBuffer += decoder.decode(value, { stream: true });
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === '[DONE]') continue;

            try {
              const event = JSON.parse(payload);
              const chunks = transformer.transform(event);
              for (const chunk of chunks) {
                const choice = chunk.choices?.[0];
                if (!choice) continue;
                if (choice.delta?.content) contentParts.push(choice.delta.content);
                if (choice.delta?.tool_calls) {
                  for (const tc of choice.delta.tool_calls) {
                    const existing = toolCallsMap.get(tc.index);
                    if (!existing) {
                      toolCallsMap.set(tc.index, {
                        id: tc.id || '', type: tc.type || 'function',
                        function: { name: tc.function?.name || '', arguments: tc.function?.arguments || '' },
                      });
                    } else {
                      if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
                    }
                  }
                }
                if (choice.finish_reason) finishReason = choice.finish_reason;
                if (chunk.usage) usage = chunk.usage;
              }
            } catch {}
          }
        }

        const message = { role: 'assistant', content: contentParts.join('') || null };
        if (toolCallsMap.size > 0) {
          message.tool_calls = Array.from(toolCallsMap.entries())
            .sort(([a], [b]) => a - b)
            .map(([, tc]) => tc);
        }

        sendJSON(res, 200, {
          id: transformer.responseID,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: bareModel,
          choices: [{ index: 0, message, finish_reason: finishReason }],
          usage,
        });
      } catch (e) {
        console.error('[OPENAI BUFFER ERROR]', e.message);
        sendJSON(res, 502, { error: { message: e.message } });
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      console.error('[OPENAI] Connect timeout');
      return sendJSON(res, 504, { error: { message: 'OpenAI upstream connect timeout' } });
    }
    console.error('[OPENAI ERROR]', e.message);
    sendJSON(res, 502, { error: { message: e.message } });
  }
}

// ═══════════════════════════════════════════════════════════════
// §7  HTTP Utilities & Request Handler
// ═══════════════════════════════════════════════════════════════

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

// ─── Request logging ───
// Nothing upstream of the provider handlers used to log anything, so every
// failure that stopped short of an upstream call — 401, 404, an unparseable
// body — was invisible: a client that never got through looked exactly like a
// client that never called. One hook on the response covers every branch,
// streaming included.

function clientIP(req) {
  // Only Caddy, on localhost, can reach this port, so its X-Forwarded-For is
  // both the sole source of the real address and safe to trust.
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || '-';
}

// Never log the presented key itself — journald keeps it for as long as the
// journal survives. A short digest still separates "sent no key" from "same
// wrong key retrying" from "a different wrong key every time".
function keyFingerprint(req) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return 'no-key';
  return `sha256:${createHash('sha256').update(token).digest('hex').slice(0, 8)}`;
}

function logRequest(req, res, { method, path, startedAt, ip }) {
  const status = res.statusCode;
  // 8640 polls a day from a single healthy client would bury everything that
  // matters, so successful requests stay quiet unless explicitly asked for.
  if (!LOG_ALL_REQUESTS && status < 400) return;
  const parts = [
    `${method} ${path}`,
    `${status}${res.writableFinished ? '' : ' (aborted)'}`,
    `${Date.now() - startedAt}ms`,
    `ip=${ip}`,
    `ua="${req.headers['user-agent'] || '-'}"`,
  ];
  if (status === 401) parts.push(`key=${keyFingerprint(req)}`);
  console.log(`[REQ] ${parts.join(' ')}`);
}

async function handleRequest(req, res) {
  const startedAt = Date.now();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method;

  // 'close' rather than 'finish': it fires for responses the client abandoned
  // mid-stream too, and writableFinished tells the two apart. The address is
  // read now, not in the listener — an abandoned request has no socket left by
  // the time it runs, which is exactly when knowing the caller matters most.
  const ip = clientIP(req);
  res.on('close', () => logRequest(req, res, { method, path, startedAt, ip }));

  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' });
    return res.end();
  }

  // API Key auth (skip for /health and /; no-op if PROXY_API_KEY unset)
  if (PROXY_API_KEY && path !== '/health' && path !== '/') {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (token !== PROXY_API_KEY) {
      return sendJSON(res, 401, { error: { message: 'Unauthorized: invalid or missing API key', type: 'auth_error' } });
    }
  }

  // Health check — show status of both providers
  if (path === '/health' || path === '/') {
    const providerStatus = {};
    for (const provider of ['anthropic', 'openai']) {
      try {
        const tok = await getOAuthTokens(provider);
        if (tok.expiresAt && Date.now() >= tok.expiresAt) {
          providerStatus[provider] = { status: 'expired', expiresAt: new Date(tok.expiresAt).toISOString() };
        } else if (tok.expiresAt) {
          const hoursLeft = ((tok.expiresAt - Date.now()) / 3600000).toFixed(1);
          providerStatus[provider] = { status: 'valid', hoursRemaining: parseFloat(hoursLeft) };
        } else {
          providerStatus[provider] = { status: 'valid', hoursRemaining: null };
        }
      } catch (e) {
        providerStatus[provider] = { status: 'unavailable', error: e.message };
      }
    }
    // Attach refresh health so a broken chain is visible even while the token
    // itself still looks valid.
    for (const provider of ['anthropic', 'openai']) {
      const s = refreshState[provider];
      providerStatus[provider].refresh = {
        consecutiveFailures: s.consecutiveFailures,
        lastError: s.lastError,
        lastSuccessAt: s.lastSuccessAt ? new Date(s.lastSuccessAt).toISOString() : null,
        lastFailureAt: s.lastFailureAt ? new Date(s.lastFailureAt).toISOString() : null,
      };
    }

    // "ok" only when every provider is actually usable. Previously one healthy
    // provider masked a completely dead one, so Anthropic could be broken for
    // six weeks while /health cheerfully reported ok.
    const allValid = Object.values(providerStatus).every(p => p.status === 'valid');
    const anyValid = Object.values(providerStatus).some(p => p.status === 'valid');
    const unhealthy = Object.entries(providerStatus)
      .filter(([, p]) => p.status !== 'valid')
      .map(([name]) => name);

    return sendJSON(res, 200, {
      status: allValid ? 'ok' : (anyValid ? 'degraded' : 'down'),
      version: VERSION,
      mode: 'unified-proxy',
      features: ['anthropic-oauth', 'openai-oauth', 'auto-refresh', 'model-routing', 'tools', 'xml-history'],
      ...(unhealthy.length > 0 && { unhealthyProviders: unhealthy }),
      providers: providerStatus,
    });
  }

  // Models list — merged from both providers
  if (path === '/v1/models' && method === 'GET') {
    // Fetch both catalogs concurrently; each falls back to its static list on failure.
    const [anthropicModels, openaiModels] = await Promise.all([
      fetchAnthropicModels(),
      fetchOpenAIModels(),
    ]);
    const allModels = [
      ...anthropicModels.map(m => ({ id: m.id, object: 'model', created: 1700000000, owned_by: 'anthropic' })),
      ...openaiModels.map(m => ({ id: m.id, object: 'model', created: 1700000000, owned_by: 'openai' })),
    ];
    return sendJSON(res, 200, { object: 'list', data: allModels });
  }

  // Chat completions — route by model
  if (path === '/v1/chat/completions' && method === 'POST') {
    let body;
    try {
      body = await parseBody(req);
    } catch (e) {
      // A body we cannot parse is the caller's mistake. This used to fall into
      // the 500 below, which pointed diagnosis at the server instead.
      return sendJSON(res, 400, { error: { message: e.message, type: 'invalid_request_error' } });
    }
    try {
      if (!body.messages) return sendJSON(res, 400, { error: { message: 'messages required' } });
      if (!body.model) body.model = DEFAULT_MODEL;

      const provider = routeRequest(body.model);
      if (provider === 'openai') {
        return handleOpenAIChat(req, res, body);
      }
      return handleAnthropicChat(req, res, body);
    } catch (e) {
      return sendJSON(res, 500, { error: { message: e.message } });
    }
  }

  sendJSON(res, 404, { error: { message: 'Not found' } });
}

// ═══════════════════════════════════════════════════════════════
// §8  CLI: --login (multi-provider OAuth)
// ═══════════════════════════════════════════════════════════════

async function loginAnthropic() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  const authUrl = new URL('https://claude.ai/oauth/authorize');
  authUrl.searchParams.set('code', 'true');
  authUrl.searchParams.set('client_id', ANTHROPIC_CLIENT_ID);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', 'https://console.anthropic.com/oauth/code/callback');
  authUrl.searchParams.set('scope', 'org:create_api_key user:profile user:inference');
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', verifier);

  console.log('\n--- Anthropic OAuth Login ---\n');
  console.log('Opening browser for authorization...\n');

  const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try { execSync(`${openCmd} "${authUrl.toString()}"`, { stdio: 'ignore' }); }
  catch { console.log('Could not open browser. Please visit:\n' + authUrl.toString() + '\n'); }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const code = await new Promise(resolve => { rl.question('Paste the authorization code here: ', resolve); });
  rl.close();

  const splits = code.trim().split('#');
  const response = await fetch(ANTHROPIC_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: splits[0],
      state: splits[1],
      grant_type: 'authorization_code',
      client_id: ANTHROPIC_CLIENT_ID,
      redirect_uri: 'https://console.anthropic.com/oauth/code/callback',
      code_verifier: verifier,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic authorization failed: ${err}`);
  }

  const json = await response.json();
  const tokens = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };

  saveTokensForProvider(tokens, 'anthropic');
  const hoursLeft = (json.expires_in / 3600).toFixed(1);
  console.log(`\nAnthropic: Success! Token valid for ${hoursLeft}h (auto-refresh enabled).`);
  return tokens;
}

async function loginOpenAI() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('hex');

  const authUrl = new URL(OPENAI_AUTH_URL);
  authUrl.searchParams.set('client_id', OPENAI_CLIENT_ID);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', OPENAI_REDIRECT_URI);
  authUrl.searchParams.set('scope', OPENAI_SCOPE_AUTH);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);

  console.log('\n--- OpenAI OAuth Login ---\n');
  console.log('Opening browser for authorization...');
  console.log('(Waiting for callback on http://localhost:1455 ...)\n');

  const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try { execSync(`${openCmd} "${authUrl.toString()}"`, { stdio: 'ignore' }); }
  catch { console.log('Could not open browser. Please visit:\n' + authUrl.toString() + '\n'); }

  // Start temporary callback server
  const code = await new Promise((resolve, reject) => {
    const callbackServer = createServer((cbReq, cbRes) => {
      const cbUrl = new URL(cbReq.url, 'http://localhost:1455');
      if (cbUrl.pathname !== '/auth/callback') {
        cbRes.writeHead(404);
        cbRes.end('Not found');
        return;
      }

      const receivedCode = cbUrl.searchParams.get('code');
      const receivedState = cbUrl.searchParams.get('state');
      const error = cbUrl.searchParams.get('error');

      if (error) {
        cbRes.writeHead(400, { 'Content-Type': 'text/html' });
        cbRes.end(`<html><body><h1>Authorization failed</h1><p>${error}</p></body></html>`);
        callbackServer.close();
        reject(new Error(`OpenAI OAuth error: ${error}`));
        return;
      }

      if (receivedState !== state) {
        cbRes.writeHead(400, { 'Content-Type': 'text/html' });
        cbRes.end('<html><body><h1>State mismatch</h1></body></html>');
        callbackServer.close();
        reject(new Error('OAuth state mismatch'));
        return;
      }

      cbRes.writeHead(200, { 'Content-Type': 'text/html' });
      cbRes.end('<html><body><h1>Authorization successful!</h1><p>You can close this window.</p></body></html>');
      callbackServer.close();
      resolve(receivedCode);
    });

    callbackServer.listen(1455, '127.0.0.1', () => {
      console.log('Listening for OAuth callback...');
    });

    // Timeout after 5 minutes
    const timeout = setTimeout(() => {
      callbackServer.close();
      reject(new Error('OpenAI login timed out (5 minutes). Please try again.'));
    }, 5 * 60 * 1000);

    callbackServer.on('close', () => clearTimeout(timeout));
  });

  // Exchange code for tokens (OpenAI uses form-urlencoded)
  const params = new URLSearchParams();
  params.set('grant_type', 'authorization_code');
  params.set('client_id', OPENAI_CLIENT_ID);
  params.set('code', code);
  params.set('redirect_uri', OPENAI_REDIRECT_URI);
  params.set('code_verifier', verifier);

  const response = await fetch(OPENAI_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI token exchange failed: ${err}`);
  }

  const json = await response.json();

  // Extract accountId from id_token JWT (sub claim)
  let accountId = null;
  if (json.id_token) {
    try {
      const parts = json.id_token.split('.');
      if (parts.length >= 2) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
        accountId = payload.sub || null;
      }
    } catch (e) {
      console.warn('[OPENAI LOGIN] Failed to parse id_token JWT:', e.message);
    }
  }
  if (!accountId) {
    console.warn('[OPENAI LOGIN] WARNING: No accountId extracted from id_token. ChatGPT Backend will not work.');
    console.warn('[OPENAI LOGIN] You may need to re-login if this persists.');
  }

  const tokens = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000,
    ...(accountId && { accountId }),
  };

  saveTokensForProvider(tokens, 'openai');
  const hoursLeft = (json.expires_in / 3600).toFixed(1);
  console.log(`\nOpenAI: Success! Token valid for ${hoursLeft}h (auto-refresh enabled).`);
  if (accountId) console.log(`  Account ID: ${accountId}`);
  return tokens;
}

// ─── CLI entry point ───
// Guarded so importing this file (tests exercise the conversion helpers directly)
// neither starts the OAuth flow nor binds the port.
const isDirectRun = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

const loginIdx = process.argv.indexOf('--login');
if (!isDirectRun) {
  // Imported as a module — expose helpers, run nothing.
} else if (loginIdx !== -1) {
  const nextArg = process.argv[loginIdx + 1];
  // Determine target: default to 'anthropic' for backward compat
  const target = (nextArg && !nextArg.startsWith('-')) ? nextArg : 'anthropic';

  (async () => {
    try {
      console.log(`\n=== Unified Proxy v${VERSION} — OAuth Login ===`);
      console.log(`Auth file: ${AUTH_FILE}\n`);

      // Ensure auth dir exists
      mkdirSync(dirname(AUTH_FILE), { recursive: true });

      if (target === 'all') {
        await loginAnthropic();
        console.log('');
        await loginOpenAI();
      } else if (target === 'openai') {
        await loginOpenAI();
      } else {
        await loginAnthropic();
      }

      console.log(`\nAll tokens saved to: ${AUTH_FILE}`);
      console.log('You can now start the server with: node server.js');
      process.exit(0);
    } catch (e) {
      console.error(`\nLogin failed: ${e.message}`);
      process.exit(1);
    }
  })();
} else {
  // ═══════════════════════════════════════════════════════════════
  // §9  Normal Server Startup
  // ═══════════════════════════════════════════════════════════════

  // Migrate legacy auth file on startup
  migrateAuthFileIfNeeded();

  const server = createServer(handleRequest);
  server.listen(PORT, HOST, async () => {
    // Check token status for each provider
    const statusLines = [];
    for (const provider of ['anthropic', 'openai']) {
      let status = 'checking...';
      try {
        const tok = await getOAuthTokens(provider);
        if (tok.expiresAt && Date.now() >= tok.expiresAt) {
          status = 'EXPIRED';
        } else if (tok.expiresAt) {
          const hoursLeft = ((tok.expiresAt - Date.now()) / 3600000).toFixed(1);
          status = `valid (${hoursLeft}h)`;
        } else {
          status = 'valid';
        }
      } catch (e) {
        status = 'not configured';
      }
      statusLines.push(`  ${provider.padEnd(10)}: ${status}`);
    }

    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║       Unified Proxy v${VERSION} (Multi-Provider OAuth)          ║
╠═══════════════════════════════════════════════════════════════╣
║  Server:  http://${HOST}:${PORT}                                  ║
║  Auth:    ${AUTH_FILE.padEnd(48)}║
║  Tokens:                                                      ║
║${statusLines[0].padEnd(63)}║
║${statusLines[1].padEnd(63)}║
║  Routing: gpt-*/o1*/o3*/o4*/codex-* → OpenAI, others → Anthropic     ║
╚═══════════════════════════════════════════════════════════════╝
`);
  });

  // Background token refresh — proactively refresh before expiry.
  // Checks every 30 min; refreshes if token expires within 2 hours.
  setInterval(async () => {
    for (const provider of ['anthropic', 'openai']) {
      try {
        const oauth = loadTokensForProvider(provider);
        if (!oauth?.refreshToken || !oauth.expiresAt) continue;
        if (Date.now() < oauth.expiresAt - REFRESH_AHEAD_MS) continue;
        console.log(`[BG REFRESH ${provider.toUpperCase()}] Token expiring soon, refreshing...`);
        const refreshed = await doRefreshToken(oauth.refreshToken, provider);
        if (refreshed) {
          saveTokensForProvider(refreshed, provider);
          cachedTokens[provider] = refreshed;
          tokenExpiry[provider] = refreshed.expiresAt;
          const hoursLeft = ((refreshed.expiresAt - Date.now()) / 3600000).toFixed(1);
          console.log(`[BG REFRESH ${provider.toUpperCase()}] Success, valid for ${hoursLeft}h`);
        } else {
          console.error(`[BG REFRESH ${provider.toUpperCase()}] Failed to refresh token`);
        }
      } catch (e) {
        // Provider not configured — skip silently
      }
    }
  }, REFRESH_CHECK_INTERVAL);

  process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
  process.on('SIGINT', () => { server.close(() => process.exit(0)); });
}

// ─── Exports (unit tests) ───
export { convertToCodexRequest, buildUserContent, extractTextContent, routeRequest, convertMessages, buildAnthropicContent };
