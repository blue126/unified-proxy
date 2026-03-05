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
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createInterface } from 'node:readline';

const PORT = process.env.PORT || 3456;
const HOST = process.env.HOST || '127.0.0.1';
const VERSION = '5.0.0';
const PROXY_API_KEY = process.env.PROXY_API_KEY || null;

// ─── Anthropic OAuth ───
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const ANTHROPIC_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';

// ─── OpenAI OAuth (cross-verified: openai/codex, open-hax/codex, codex-proxy) ───
const OPENAI_PLATFORM_API_URL = 'https://api.openai.com/v1/chat/completions';  // 保留，未来 API credits 可用
const OPENAI_CHATGPT_BACKEND_URL = 'https://chatgpt.com/backend-api/codex/responses';  // 订阅计费
const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

// ─── Codex CLI impersonation (required by ChatGPT Backend) ───
const CODEX_CLI_VERSION = '0.104.0';
const CODEX_CLI_UA = `codex_cli_rs/${CODEX_CLI_VERSION}`;
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
const DEFAULT_ANTHROPIC_MODELS = [
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  { id: 'claude-opus-4-5', name: 'Claude Opus 4.5' },
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
];

const DEFAULT_OPENAI_MODELS = [
  { id: 'gpt-5.2', name: 'GPT-5.2' },
  { id: 'o3-pro', name: 'o3 Pro' },
];

// ─── Auth file (dual-section: { anthropic: {...}, openai: {...} }) ───
const AUTH_FILE = process.env.PROXY_AUTH_FILE || join(homedir(), '.unified-proxy', 'auth.json');

// ─── Timeouts for upstream API calls ───
const CONNECT_TIMEOUT_MS = 10_000;  // 10s connect timeout

// ─── Background refresh config ───
const REFRESH_CHECK_INTERVAL = 30 * 60 * 1000;  // 30 min
const REFRESH_AHEAD_MS = 2 * 60 * 60 * 1000;    // 2 hours before expiry

// ─── Token caching (per-provider) ───
let cachedTokens = { anthropic: null, openai: null };
let tokenExpiry = { anthropic: 0, openai: 0 };

// ═══════════════════════════════════════════════════════════════
// §1  Model Routing
// ═══════════════════════════════════════════════════════════════

function routeRequest(model) {
  const bare = stripPrefix(model);
  if (/^(gpt-|o1|o3|o4)/.test(bare)) return 'openai';
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
    writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
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

async function doRefreshToken(refreshTok, provider = 'anthropic') {
  const tokenUrl = provider === 'openai' ? OPENAI_TOKEN_URL : ANTHROPIC_TOKEN_URL;
  const clientId = provider === 'openai' ? OPENAI_CLIENT_ID : ANTHROPIC_CLIENT_ID;

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
      });
    } else {
      // Anthropic uses application/json
      response = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshTok, client_id: clientId }),
      });
    }

    if (!response.ok) {
      const err = await response.text();
      console.error(`[${provider.toUpperCase()} TOKEN REFRESH FAILED] Status ${response.status}: ${err}`);
      return null;
    }
    const data = await response.json();
    console.log(`[${provider.toUpperCase()} TOKEN REFRESH] Success, valid for ${(data.expires_in / 3600).toFixed(1)}h`);
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshTok,
      expiresAt: Date.now() + (data.expires_in * 1000),
    };
  } catch (e) {
    console.error(`[${provider.toUpperCase()} TOKEN REFRESH ERROR] ${e.message}`);
    return null;
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

function convertMessages(messages, tools) {
  let systemPrompts = [];
  const anthropicMessages = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemPrompts.push(extractText(msg.content));
    } else if (msg.role === 'user') {
      const content = extractText(msg.content);
      if (content) {
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
      fixedMessages[fixedMessages.length - 1].content += '\n\n' + msg.content;
    } else {
      fixedMessages.push(msg);
    }
  }

  // Inject tool context into first user message
  const toolContext = buildToolContext(tools, systemPrompts);
  if (toolContext && fixedMessages.length > 0) {
    for (let i = 0; i < fixedMessages.length; i++) {
      if (fixedMessages[i].role === 'user') {
        fixedMessages[i].content = toolContext + '[User Message]\n' + fixedMessages[i].content;
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
  const { model, messages, temperature, max_tokens, tools, stream, thinking } = body;
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
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'oauth-2025-04-20,interleaved-thinking-2025-05-14,prompt-caching-2024-07-31',
    'user-agent': 'claude-cli/2.1.2 (external, cli)',
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
  // thinking requires temperature to be unset (Anthropic API restriction)
  if (thinking) {
    requestBody.thinking = thinking;
  } else if (temperature !== undefined) {
    requestBody.temperature = temperature;
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
  const { messages, model, tools, tool_choice, max_tokens, temperature, top_p, stop, n, reasoning_effort } = body;

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
        const text = extractTextContent(msg.content);
        if (text) {
          input.push({
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text }],
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

  // Build Codex request body
  const codexBody = {
    model: stripPrefix(model),
    store: false,
    stream: true,
  };

  if (instructions.length > 0) {
    codexBody.instructions = instructions.join('\n\n');
  }
  if (input.length > 0) {
    codexBody.input = input;
  }

  // Sampling parameters
  if (max_tokens !== undefined) codexBody.max_output_tokens = max_tokens;
  if (temperature !== undefined) codexBody.temperature = temperature;
  if (top_p !== undefined) codexBody.top_p = top_p;
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

/** Extract text from string or array content (Chat Completions format). */
function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = [];
    for (const part of content) {
      if (part.type === 'text' && part.text) {
        texts.push(part.text);
      } else if (part.type === 'image_url') {
        return null; // signal unsupported multimodal — caller decides
      }
    }
    return texts.join('\n') || null;
  }
  return null;
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

        // Extract usage
        const respUsage = event.response?.usage;
        if (respUsage) {
          const prompt_tokens = respUsage.input_tokens ?? respUsage.prompt_tokens ?? 0;
          const completion_tokens = respUsage.output_tokens ?? respUsage.completion_tokens ?? 0;
          this.usage = { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens };
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

  // 1. Get OAuth tokens
  let tokens;
  try { tokens = await getOAuthTokens('openai'); }
  catch (e) { return sendJSON(res, 503, { error: { message: e.message, type: 'provider_unavailable' } }); }

  // 2. Check accountId (required for ChatGPT Backend)
  if (!tokens.accountId) {
    return sendJSON(res, 503, { error: {
      message: 'OpenAI accountId missing. Re-run "node server.js --login openai" on the host to capture accountId from OAuth.',
      type: 'provider_unavailable',
    } });
  }

  // 3. Convert Chat Completions → Codex Responses format
  const { error: convError, codexBody } = convertToCodexRequest(body);
  if (convError) {
    return sendJSON(res, 400, { error: convError });
  }

  console.log(`[OPENAI] → ChatGPT Backend: model=${codexBody.model}, input=${codexBody.input?.length || 0}, tools=${codexBody.tools?.length || 0}`);

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
        'chatgpt-account-id': tok.accountId,
        'openai-beta': 'responses=experimental',
        'originator': 'codex_cli_rs',
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

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method;

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
    const anyValid = Object.values(providerStatus).some(p => p.status === 'valid');
    return sendJSON(res, 200, {
      status: anyValid ? 'ok' : 'degraded',
      version: VERSION,
      mode: 'unified-proxy',
      features: ['anthropic-oauth', 'openai-oauth', 'auto-refresh', 'model-routing', 'tools', 'xml-history'],
      providers: providerStatus,
    });
  }

  // Models list — merged from both providers
  if (path === '/v1/models' && method === 'GET') {
    const allModels = [
      ...ANTHROPIC_MODELS.map(m => ({ id: m.id, object: 'model', created: 1700000000, owned_by: 'anthropic' })),
      ...OPENAI_MODELS.map(m => ({ id: m.id, object: 'model', created: 1700000000, owned_by: 'openai' })),
    ];
    return sendJSON(res, 200, { object: 'list', data: allModels });
  }

  // Chat completions — route by model
  if (path === '/v1/chat/completions' && method === 'POST') {
    try {
      const body = await parseBody(req);
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
const loginIdx = process.argv.indexOf('--login');
if (loginIdx !== -1) {
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
║  Routing: gpt-*/o1*/o3*/o4* → OpenAI, others → Anthropic     ║
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
