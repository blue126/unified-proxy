#!/usr/bin/env node
// Two separate invocations; no browser, callback listener, or interactive stdin.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Same OAuth client and redirect as server.js's interactive Claude login.
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const SESSION_TTL = 15 * 60 * 1000;

function writePrivateJSON(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readObject(path) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a JSON object; existing credentials were not changed.');
  }
  return value;
}

export function startLogin(stateFile, now = Date.now()) {
  const verifier = randomBytes(32).toString('base64url');
  // Unlike the verifier, state may appear in the authorization URL and logs.
  const state = randomBytes(24).toString('base64url');
  const expiresAt = now + SESSION_TTL;
  writePrivateJSON(stateFile, { verifier, state, expiresAt });
  const url = new URL('https://claude.ai/oauth/authorize');
  url.search = new URLSearchParams({
    code: 'true', client_id: CLIENT_ID, response_type: 'code',
    redirect_uri: REDIRECT_URI, scope: 'org:create_api_key user:profile user:inference',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256', state,
  }).toString();
  return { url: url.toString(), expiresAt };
}

export async function completeLogin({ stateFile, authFile, code, now = Date.now(), fetchImpl = fetch }) {
  const session = readObject(stateFile);
  if (!Number.isFinite(session.expiresAt) || now >= session.expiresAt) {
    rmSync(stateFile, { force: true });
    throw new Error('Login session expired. Run start again.');
  }
  const match = /^([A-Za-z0-9_-]+)#([A-Za-z0-9_-]+)$/.exec(code?.trim() || '');
  if (!match || match[2] !== session.state || !/^[A-Za-z0-9_-]{43}$/.test(session.verifier)) {
    throw new Error('Invalid authorization code or state mismatch. Use the code from the latest start.');
  }
  // Fail closed on missing or corrupt auth.json, rather than lose OpenAI's chain.
  // The service must be stopped during completion to exclude its refresh writer.
  const existing = readObject(authFile);
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: match[1], state: session.state, grant_type: 'authorization_code',
      client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, code_verifier: session.verifier,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    // Never log upstream bodies: they may echo codes or credentials.
    throw new Error(`Claude token exchange failed (HTTP ${response.status}). Run start again.`);
  }
  const tokens = await response.json();
  if (typeof tokens.access_token !== 'string' || !tokens.access_token ||
      typeof tokens.refresh_token !== 'string' || !tokens.refresh_token ||
      !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) {
    throw new Error('Claude token exchange returned incomplete credentials. Run start again.');
  }
  // Legacy flat files contained only Anthropic credentials.
  const merged = existing.accessToken ? { anthropic: existing } : existing;
  merged.anthropic = {
    accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };
  writePrivateJSON(authFile, merged);
  rmSync(stateFile, { force: true });
}

const direct = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  const authFile = process.env.PROXY_AUTH_FILE || join(homedir(), '.unified-proxy', 'auth.json');
  const stateFile = process.env.CLAUDE_LOGIN_STATE_FILE || `${authFile}.anthropic-login.json`;
  try {
    if (process.argv[2] === 'start') {
      const login = startLogin(stateFile);
      console.log(`Open this URL in your own browser:\n${login.url}`);
      console.log(`Complete before ${new Date(login.expiresAt).toISOString()}. Starting again replaces the pending login.`);
    } else if (process.argv[2] === 'complete') {
      await completeLogin({ authFile, stateFile, code: process.env.CLAUDE_AUTH_CODE });
      chmodSync(authFile, 0o600);
      console.log('Claude credentials saved. Existing OpenAI credentials preserved.');
    } else {
      throw new Error('Usage: node scripts/claude-headless-auth.js start|complete (complete uses CLAUDE_AUTH_CODE).');
    }
  } catch (error) {
    // File/JSON errors may include sensitive input in newer Node versions.
    const message = error instanceof SyntaxError ? 'Invalid JSON; existing credentials were not changed.' : error.message;
    console.error(message);
    process.exitCode = 1;
  }
}
