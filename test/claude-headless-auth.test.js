import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { completeLogin, startLogin } from '../scripts/claude-headless-auth.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-headless-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateFile = join(dir, 'pending.json');
  const authFile = join(dir, 'auth.json');
  const original = { anthropic: { accessToken: 'old' }, openai: { accessToken: 'openai', refreshToken: 'rolling', expiresAt: 123 }, metadata: 'keep' };
  writeFileSync(authFile, JSON.stringify(original));
  const login = startLogin(stateFile);
  const session = JSON.parse(readFileSync(stateFile));
  return { dir, stateFile, authFile, original, login, session, code: `one-time-code#${session.state}` };
}

test('headless start keeps the PKCE verifier private and creates fresh expiring sessions', t => {
  const f = fixture(t);
  const url = new URL(f.login.url);
  assert.equal(url.searchParams.get('state'), f.session.state);
  assert.notEqual(f.session.state, f.session.verifier);
  assert.ok(!f.login.url.includes(f.session.verifier));
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(f.session.verifier).digest('base64url'));
  assert.equal(statSync(f.stateFile).mode & 0o777, 0o600);
  assert.equal(f.session.expiresAt - Date.now() > 14 * 60000, true);
  const replacement = startLogin(f.stateFile);
  assert.notEqual(new URL(replacement.url).searchParams.get('state'), f.session.state);
});

test('completion exchanges the bound code and atomically preserves OpenAI and file permissions', async t => {
  const f = fixture(t);
  await completeLogin({ ...f, fetchImpl: async (url, options) => {
    assert.equal(new URL(url).host, 'console.anthropic.com');
    const body = JSON.parse(options.body);
    assert.equal(body.code, 'one-time-code');
    assert.equal(body.state, f.session.state);
    assert.equal(body.code_verifier, f.session.verifier);
    return { ok: true, json: async () => ({ access_token: 'new', refresh_token: 'new-refresh', expires_in: 3600 }) };
  } });
  const saved = JSON.parse(readFileSync(f.authFile));
  assert.deepEqual(saved.openai, f.original.openai);
  assert.equal(saved.metadata, 'keep');
  assert.equal(saved.anthropic.accessToken, 'new');
  assert.equal(saved.anthropic.refreshToken, 'new-refresh');
  assert.equal(statSync(f.authFile).mode & 0o777, 0o600);
  assert.equal(existsSync(f.stateFile), false);
  await assert.rejects(completeLogin({ ...f }), { code: 'ENOENT' });
});

test('mismatched, expired and replaced sessions cannot exchange or change credentials', async t => {
  const f = fixture(t);
  const fetchImpl = () => { throw new Error('must not contact upstream'); };
  await assert.rejects(completeLogin({ ...f, code: 'one-time-code#wrong', fetchImpl }), /state mismatch/);
  startLogin(f.stateFile);
  await assert.rejects(completeLogin({ ...f, fetchImpl }), /state mismatch/);
  const session = JSON.parse(readFileSync(f.stateFile));
  await assert.rejects(completeLogin({ ...f, now: session.expiresAt, fetchImpl }), /expired/);
  assert.equal(existsSync(f.stateFile), false);
  assert.deepEqual(JSON.parse(readFileSync(f.authFile)), f.original);
});

test('corrupt or missing auth files are never replaced with only Claude credentials', async t => {
  const f = fixture(t);
  const fetchImpl = () => { throw new Error('must not contact upstream'); };
  writeFileSync(f.authFile, '{broken');
  await assert.rejects(completeLogin({ ...f, fetchImpl }), SyntaxError);
  assert.equal(readFileSync(f.authFile, 'utf8'), '{broken');
  rmSync(f.authFile);
  await assert.rejects(completeLogin({ ...f, fetchImpl }), { code: 'ENOENT' });
});

test('upstream failures and incomplete token responses leave both providers untouched', async t => {
  const f = fixture(t);
  await assert.rejects(completeLogin({ ...f, fetchImpl: async () => ({ ok: false, status: 400, text: () => { throw new Error('do not log body'); } }) }), /HTTP 400/);
  await assert.rejects(completeLogin({ ...f, fetchImpl: async () => ({ ok: true, json: async () => ({ access_token: 'new' }) }) }), /incomplete/);
  assert.deepEqual(JSON.parse(readFileSync(f.authFile)), f.original);
});

for (const scenario of ['success', 'exchange-failed', 'inactive', 'stop-failed']) {
  test(`maintenance restores service appropriately: ${scenario}`, t => {
    const f = fixture(t);
    const log = join(f.dir, 'commands.log');
    const wrappers = {
      sudo: `#!/bin/bash
printf '%s\\n' "$*" >> "$TEST_COMMAND_LOG"
if [[ "$*" == 'systemctl is-active --quiet unified-proxy' && "$TEST_SCENARIO" == inactive ]]; then exit 3; fi
if [[ "$*" == 'systemctl stop unified-proxy' && "$TEST_SCENARIO" == stop-failed ]]; then exit 1; fi
`,
      node: `#!/bin/bash
printf 'token-exchange\\n' >> "$TEST_COMMAND_LOG"
if [[ "$TEST_SCENARIO" == exchange-failed ]]; then exit 1; fi
`,
      curl: '#!/bin/bash\nprintf "{\\"status\\":\\"ok\\"}\\n"\n',
    };
    for (const [name, text] of Object.entries(wrappers)) {
      writeFileSync(join(f.dir, name), text, { mode: 0o700 });
    }
    const result = spawnSync('/bin/bash', [fileURLToPath(new URL('../scripts/server-maintenance.sh', import.meta.url)), 'claude-login-complete'], {
      env: { ...process.env, PATH: `${f.dir}:/usr/bin:/bin`, TEST_COMMAND_LOG: log, TEST_SCENARIO: scenario },
      encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, scenario === 'success' ? 0 : scenario === 'inactive' ? 3 : 1, result.stderr);
    const commands = readFileSync(log, 'utf8').trim().split('\n');
    if (scenario === 'inactive') {
      assert.deepEqual(commands, ['systemctl is-active --quiet unified-proxy']);
    } else {
      assert.equal(commands[1], 'systemctl stop unified-proxy');
      assert.equal(commands.at(-1), 'systemctl start unified-proxy');
      assert.equal(commands.filter(c => c === 'systemctl start unified-proxy').length, 1);
      assert.equal(commands.includes('token-exchange'), scenario !== 'stop-failed');
    }
  });
}
