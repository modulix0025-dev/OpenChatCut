// In-app Claude Code sign-in, shared CLI environment and connection test.
// Uses a fake `claude` script, so it runs without the real CLI or a network.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ClaudeCodeLoginError,
  ClaudeCodeLoginManager,
  loginArgs,
  officialAuthUrl,
  validAccountType,
  validLoginEmail,
} from './login.ts';
import { claudeCodeChildEnvironment, claudeCodeEnvOverrides } from './environment.ts';
import { interpretTestOutput } from './connection-test.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for: ${label}`);
    await sleep(20);
  }
}

// ── pure helpers ────────────────────────────────────────────────────────────
assert.deepEqual(loginArgs({ accountType: 'claudeai' }), ['auth', 'login', '--claudeai']);
assert.deepEqual(loginArgs({ accountType: 'console', email: 'a@b.co', sso: true }),
  ['auth', 'login', '--console', '--email', 'a@b.co', '--sso']);
assert.equal(validAccountType(undefined), 'claudeai');
assert.equal(validAccountType('console'), 'console');
assert.throws(() => validAccountType('--settings'), ClaudeCodeLoginError);
assert.equal(validLoginEmail(''), undefined);
assert.equal(validLoginEmail(' user.name+x@example.com '), 'user.name+x@example.com');
for (const bad of ['--sso', 'a@b', 'a b@c.com', '"x"@y.com', 'x@y.com --console', 42]) {
  assert.throws(() => validLoginEmail(bad), ClaudeCodeLoginError, `rejects ${String(bad)}`);
}
assert.ok(officialAuthUrl('https://claude.com/cai/oauth/authorize?code=true&x=1'));
assert.ok(officialAuthUrl('https://platform.claude.com/oauth/authorize?code=true'));
assert.ok(officialAuthUrl('https://console.anthropic.com/oauth/authorize'));
assert.ok(officialAuthUrl('https://claude.ai/oauth/authorize).'), 'trailing punctuation trimmed');
for (const bad of [
  'http://claude.ai/oauth', 'https://claude.ai.evil.com/x', 'https://evilclaude.ai/x',
  'https://user@claude.ai/x', 'https://claude.ai:8443/x', 'javascript:alert(1)',
]) assert.equal(officialAuthUrl(bad), null, `rejects ${bad}`);

// ── environment: allow-list plus the variables that pick the account ────────
const env = claudeCodeChildEnvironment({
  PATH: '/bin', USERPROFILE: 'C:\\Users\\me', ProgramFiles: 'C:\\Program Files',
  CLAUDE_CONFIG_DIR: '/cfg', CLAUDE_CODE_OAUTH_TOKEN: 'tok', CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bin\\bash.exe',
  OPENAI_API_KEY: 'secret', FAL_KEY: 'secret', EMPTY: '', CLAUDE_CODE_USE_VERTEX: '',
});
assert.equal(env.PATH, '/bin');
assert.equal(env.ProgramFiles, 'C:\\Program Files', 'Windows system variables reach the CLI');
assert.equal(env.CLAUDE_CONFIG_DIR, '/cfg');
assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'tok');
assert.equal(env.CLAUDE_CODE_GIT_BASH_PATH, 'C:\\Git\\bin\\bash.exe');
assert.equal(env.OPENAI_API_KEY, undefined, 'unrelated secrets stay out');
assert.equal(env.FAL_KEY, undefined);
assert.equal('CLAUDE_CODE_USE_VERTEX' in env, false, 'empty values are dropped');
assert.deepEqual(claudeCodeEnvOverrides({ CLAUDE_CODE_OAUTH_TOKEN: 'x', ANTHROPIC_API_KEY: ' ' }), ['CLAUDE_CODE_OAUTH_TOKEN']);

// ── connection test output ──────────────────────────────────────────────────
const okResult = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK', modelUsage: { 'claude-sonnet-5': {} } });
assert.deepEqual(interpretTestOutput(`${okResult}\n`, '', 0, 5), { ok: true, message: 'OK', durationMs: 5, model: 'claude-sonnet-5' });
const authFail = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' });
assert.deepEqual(interpretTestOutput(authFail, '', 1, 7), { ok: false, message: 'Not logged in · Please run /login', durationMs: 7 });
assert.equal(interpretTestOutput('', 'error: unknown option --x\n', 1, 1).message, 'error: unknown option --x');
assert.equal(interpretTestOutput('', '', 3, 1).message, 'Claude Code exited with code 3.');

// ── login manager against a fake CLI ────────────────────────────────────────
if (process.platform !== 'win32') {
  const dir = await mkdtemp(join(tmpdir(), 'occ-claude-login-verify-'));
  const argsLog = join(dir, 'args.txt');
  const fake = join(dir, 'claude');
  await writeFile(fake, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)));
const mode = process.env.FAKE_MODE || 'code';
if (mode === 'no-url') { setTimeout(() => process.exit(0), 300); return; }
if (mode === 'crash') { console.error('\\u001b[31mOAuth error: network unreachable\\u001b[0m'); process.exit(2); }
process.stdout.write('Opening browser to sign in…\\n');
process.stdout.write('If the browser didn\\'t open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc\\n');
process.stdout.write('Paste code here if prompted > ');
if (mode === 'callback') { setTimeout(() => { console.log('Login successful.'); process.exit(0); }, 200); return; }
if (mode === 'hang') { setInterval(() => {}, 1000); return; }
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (!input.includes('\\n')) return;
  if (input.trim() === 'good-code#state') { console.log('Login successful.'); process.exit(0); }
  console.error('OAuth error: Invalid code'); process.exit(1);
});
`, 'utf8');
  await chmod(fake, 0o755);
  const run = async (mode: string, fn: (manager: ClaudeCodeLoginManager) => Promise<void>, options = {}) => {
    // The allow-listed environment drops FAKE_MODE, so the test spawn adds it back.
    const manager = new ClaudeCodeLoginManager({
      spawn: (executable, args, spawnOptions) => spawn(executable, args, {
        ...spawnOptions, env: { ...spawnOptions?.env, FAKE_MODE: mode },
      }),
      ...options,
    });
    await fn(manager);
  };

  await run('code', async (manager) => {
    const state = await manager.start(fake, { accountType: 'console', email: 'me@example.com' });
    assert.equal(state.status, 'waiting');
    assert.equal(state.authUrl, 'https://claude.com/cai/oauth/authorize?code=true&state=abc');
    await until(() => manager.current()?.codePrompt === true, 'code prompt');
    const { readFile } = await import('node:fs/promises');
    assert.deepEqual(JSON.parse(await readFile(argsLog, 'utf8')), ['auth', 'login', '--console', '--email', 'me@example.com']);
    assert.throws(() => manager.submitCode('other-id', 'good-code#state'), ClaudeCodeLoginError, 'wrong login id');
    assert.throws(() => manager.submitCode(state.id, 'bad code; rm'), ClaudeCodeLoginError, 'code shape checked');
    assert.equal(manager.submitCode(state.id, 'good-code#state').status, 'code-submitted');
    await until(() => manager.current()?.status === 'succeeded', 'success after code');
    assert.equal(manager.pending, false);
  });

  await run('code', async (manager) => {
    const state = await manager.start(fake, { accountType: 'claudeai' });
    await until(() => manager.current()?.codePrompt === true, 'code prompt');
    manager.submitCode(state.id, 'wrong-code-123');
    await until(() => manager.current()?.status === 'failed', 'failure after wrong code');
    assert.equal(manager.current()?.error, 'OAuth error: Invalid code');
  });

  await run('callback', async (manager) => {
    await manager.start(fake, { accountType: 'claudeai' });
    await until(() => manager.current()?.status === 'succeeded', 'success via browser callback');
  });

  await run('crash', async (manager) => {
    await manager.start(fake, { accountType: 'claudeai' });
    await until(() => manager.current()?.status === 'failed', 'crash reported');
    assert.equal(manager.current()?.error, 'OAuth error: network unreachable', 'ANSI stripped, real message kept');
  });

  await run('hang', async (manager) => {
    const first = await manager.start(fake, { accountType: 'claudeai' });
    const second = await manager.start(fake, { accountType: 'console' });
    assert.notEqual(first.id, second.id, 'a new sign-in replaces the old one');
    manager.cancel('not-this-one');
    assert.equal(manager.pending, true, 'cancel with another id is ignored');
    manager.cancel(second.id);
    assert.equal(manager.current()?.status, 'cancelled');
    assert.equal(manager.pending, false);
  });

  await run('hang', async (manager) => {
    await manager.start(fake, { accountType: 'claudeai' });
    await until(() => manager.current()?.status === 'failed', 'timeout');
    assert.match(manager.current()?.error ?? '', /timed out/);
  }, { timeoutMs: 400 });

  await run('no-url', async (manager) => {
    const state = await manager.start(fake, { accountType: 'claudeai' });
    assert.equal(state.authUrl, null, 'a CLI that only opens the browser still works');
    await until(() => manager.current()?.status === 'succeeded', 'success without printed link');
  }, { urlWaitMs: 100 });

  await rm(dir, { recursive: true, force: true });
}

console.log('claude-code-login.verify: sign-in, code, cancel, timeout, env and connection test passed');

// ── official installer + Windows install locations ─────────────────────────
{
  const { claudeCodeInstallerCommand, installClaudeCode } = await import('./installer.ts');
  const { windowsCandidates } = await import('./installation.ts');
  const win = claudeCodeInstallerCommand('win32');
  assert.match(win.executable, /WindowsPowerShell\\v1\.0\\powershell\.exe$/);
  assert.equal(win.args.at(-1)?.endsWith('irm https://claude.ai/install.ps1 | iex'), true, 'the documented Windows command');
  assert.deepEqual(claudeCodeInstallerCommand('darwin').args, ['-c', 'set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash']);
  const found = async () => '/home/me/.local/bin/claude';
  const notFound = async () => null;

  const ok = await installClaudeCode({ locate: found, command: { executable: process.execPath, args: ['-e', 'console.log("\\u001b[32mClaude Code successfully installed!\\u001b[0m")'] } });
  assert.deepEqual([ok.ok, ok.message], [true, 'Claude Code successfully installed!\n/home/me/.local/bin/claude']);
  const silent = await installClaudeCode({ locate: notFound, command: { executable: process.execPath, args: ['-e', ''] } });
  assert.equal(silent.ok, false, 'exit 0 without a CLI afterwards is a failure');
  assert.match(silent.message, /not found afterwards/);
  const piped = await installClaudeCode({ locate: found, command: { executable: '/bin/bash', args: ['-c', 'set -o pipefail; false | bash'] } });
  assert.equal(piped.ok, false, 'a failed download in the pipe fails the install');
  const failed = await installClaudeCode({ command: { executable: process.execPath, args: ['-e', 'console.error("download failed: 403"); process.exit(1)'] } });
  assert.deepEqual([failed.ok, failed.message], [false, 'download failed: 403']);
  const missing = await installClaudeCode({ command: { executable: '/nonexistent/installer', args: [] } });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /Could not start the installer/);
  const slow = { executable: process.execPath, args: ['-e', 'setTimeout(() => console.log("done"), 300)'] };
  const [a, b] = await Promise.all([installClaudeCode({ command: slow, locate: found }), installClaudeCode({ command: slow, locate: found })]);
  assert.equal(a, b, 'concurrent installs share one run');
  const timedOut = await installClaudeCode({ command: { executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }, timeoutMs: 200 });
  assert.match(timedOut.message, /did not finish/);

  const saved = { ...process.env };
  Object.assign(process.env, { USERPROFILE: 'C:/Users/me', APPDATA: 'C:/Users/me/AppData/Roaming', LOCALAPPDATA: 'C:/Users/me/AppData/Local' });
  const candidates = windowsCandidates().map((path) => path.replace(/\\/g, '/'));
  process.env = saved;
  for (const expected of [
    'C:/Users/me/.local/bin/claude.exe',
    'C:/Users/me/AppData/Local/Microsoft/WinGet/Links/claude.exe',
    'C:/Users/me/AppData/Roaming/npm/claude.cmd',
    'C:/Users/me/scoop/shims/claude.exe',
  ]) assert.ok(candidates.includes(expected), `probes ${expected}`);
}
console.log('claude-code-login.verify: installer and Windows install locations passed');
