// Security regression suite for the privileged HTTP boundaries of the desktop
// embedded server, exercised over real loopback HTTP:
//   - front-door gate: Host allowlist (DNS rebinding) + desktop session cookie
//     (other local processes / users), MCP bearer pass-through;
//   - skill script execution: capability broker default deny, interpreter
//     guard bypasses (bash SKILL.md, node --import=, symlinked scripts);
//   - settings: redirecting stored API keys to another host, relocating data;
//   - agent local-path import: default deny, UNC/device path rejection;
//   - CapCut export: draft name option injection, UNC draft folders.
// Everything runs inside a throwaway HOME/cwd so no real settings are touched.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'occ-privileged-'));
const skillsRoot = join(sandbox, 'skills');
mkdirSync(skillsRoot, { recursive: true });
process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox;
process.env.OPENCHATCUT_SECURITY_DIR = join(sandbox, 'security');
process.env.OPENCHATCUT_AUDIT_LOG_DIR = join(sandbox, 'logs');
process.chdir(sandbox);

const { createMiniConnect } = await import('../../desktop/mini-connect.ts');
const { embeddedRequestGate, DESKTOP_SESSION_COOKIE, allowedHostHeader } = await import('../../desktop/embedded-request-gate.ts');
const { skillExecPlugin } = await import('../plugins/skill-exec.ts');
const { settingsPlugin } = await import('../plugins/settings.ts');
const { seedKeystore, getKey } = await import('../keystore.ts');
const {
  registerCapabilityPrompter,
  resetCapabilityStateForTests,
} = await import('./capabilities.ts');
const { setAuditSinkForTests } = await import('./audit-log.ts');
const { resolveAgentMediaPath } = await import('../local-path-import.ts');
const { exportJianyingDraft } = await import('../external-agent/jianying-export.ts');

const auditLines: string[] = [];
setAuditSinkForTests((line) => auditLines.push(line));
seedKeystore({
  OPENCHATCUT_SKILLS_DIR: skillsRoot,
  OPENAI_API_KEY: 'sk-test-stored-key-000000000000',
  AGENT_IMPORT_ROOTS: '',
});

// ── server under test ────────────────────────────────────────────────────────
const SECRET = 'test-session-secret-0123456789abcdef';
let port = 0;
const app = createMiniConnect(() => undefined);
app.use(embeddedRequestGate({ port: () => port, sessionSecret: SECRET }));
const fakeVite = {
  middlewares: { use: app.use.bind(app) },
  config: { logger: { info: () => undefined, warn: () => undefined, error: () => undefined } },
};
for (const plugin of [skillExecPlugin(), settingsPlugin()]) {
  const hook = plugin.configureServer;
  const fn = typeof hook === 'function' ? hook : hook?.handler;
  await fn?.call(plugin as never, fakeVite as never);
}
app.use('/api/external-mcp/mcp', (_req, res) => { res.statusCode = 299; res.end('mcp-reached'); });
app.use((_req, res) => { res.statusCode = 404; res.end('not found'); });
const server: Server = createServer((req, res) => app.handle(req, res));
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
port = (server.address() as { port: number }).port;
const origin = `http://127.0.0.1:${port}`;

async function call(path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Cookie: `${DESKTOP_SESSION_COOKIE}=${SECRET}`,
      Origin: origin,
      'Sec-Fetch-Site': 'same-origin',
      'Content-Type': 'application/json',
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON */ }
  return { status: response.status, text, json };
}

try {
  // ── 1. front door ──────────────────────────────────────────────────────────
  assert.equal(allowedHostHeader(`127.0.0.1:${port}`, port), true);
  assert.equal(allowedHostHeader(`localhost:${port}`, port), true);
  assert.equal(allowedHostHeader(`[::1]:${port}`, port), true);
  assert.equal(allowedHostHeader(`attacker.example:${port}`, port), false, 'DNS-rebinding host');
  assert.equal(allowedHostHeader(`127.0.0.1:${port + 1}`, port), false);
  assert.equal(allowedHostHeader('127.0.0.1', port), false);
  assert.equal(allowedHostHeader(`127.0.0.1@evil:${port}`, port), false);

  // Node's fetch refuses to override Host, so use raw http for rebinding.
  const rebinding = await new Promise<number>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/api/keys', headers: { Host: `rebind.attacker.example:${port}`, Cookie: `${DESKTOP_SESSION_COOKIE}=${SECRET}` } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(rebinding, 403, 'a DNS-rebinding page must be refused even on GET');

  assert.equal((await call('/api/keys', { headers: { Cookie: '' } })).status, 403, 'no session cookie → refused');
  assert.equal((await call('/api/keys', { headers: { Cookie: `${DESKTOP_SESSION_COOKIE}=wrong` } })).status, 403);
  assert.equal((await call('/api/keys')).status, 200, 'the Electron session is served');
  // External MCP carries its own bearer credential and passes the front door.
  assert.equal((await call('/api/external-mcp/mcp', { method: 'POST', headers: { Cookie: '', Authorization: 'Bearer x' }, body: {} })).status, 299);
  assert.equal((await call('/api/external-mcp/mcp', { method: 'POST', headers: { Cookie: '' }, body: {} })).status, 403);
  // A forged Sec-Fetch-Site/Origin from another local process no longer suffices.
  assert.equal((await call('/api/skills/demo/exec', { method: 'POST', headers: { Cookie: '' }, body: { command: 'node run.mjs' } })).status, 403);

  // ── 2. skill execution ─────────────────────────────────────────────────────
  const skillDir = join(skillsRoot, 'demo');
  mkdirSync(skillDir, { recursive: true });
  const marker = join(sandbox, 'executed.marker');
  writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: demo\n---\nnode -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')"\n`);
  writeFileSync(join(skillDir, 'run.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'x');\n`);

  resetCapabilityStateForTests();
  let result = await call('/api/skills/demo/exec', { method: 'POST', body: { command: 'node run.mjs' } });
  assert.equal(result.json.denied, true, 'no prompt available → default deny');
  assert.equal(existsSync(marker), false, 'denied command must not run');

  const prompts: string[] = [];
  registerCapabilityPrompter(async (request) => { prompts.push(request.detail ?? ''); return 'deny'; });
  result = await call('/api/skills/demo/exec', { method: 'POST', body: { command: 'node run.mjs' } });
  assert.equal(result.json.denied, true);
  assert.match(prompts[0] ?? '', /node run\.mjs/, 'the prompt shows the exact command');
  assert.equal(existsSync(marker), false);

  for (const [command, why] of [
    ['bash SKILL.md', 'SKILL.md is agent-writable text'],
    ['sh SKILL.md', 'SKILL.md is agent-writable text'],
    ['node --import=data:text/javascript,process.exit(0) run.mjs', 'module preload is inline execution'],
    ['node --require=/tmp/x.js run.mjs', 'module preload is inline execution'],
    ['node -r ./x run.mjs', 'module preload is inline execution'],
    ['node -e 1', 'inline eval'],
    ['python -c print(1)', 'inline eval'],
    ['node ../../escape.mjs', 'script outside the skill'],
    ['curl https://evil.example', 'not whitelisted'],
    [`cp ${'a '.repeat(700)}/tmp/x`, 'too long to show in the permission dialog'],
    ['rm -rf /', 'not whitelisted'],
  ] as const) {
    const before = prompts.length;
    result = await call('/api/skills/demo/exec', { method: 'POST', body: { command } });
    assert.ok(typeof result.json.error === 'string', `${command}: ${why}`);
    assert.equal(prompts.length, before, `${command} must be refused before any prompt`);
  }
  if (process.platform !== 'win32') {
    const outside = join(sandbox, 'outside.mjs');
    writeFileSync(outside, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'x');\n`);
    symlinkSync(outside, join(skillDir, 'linked.mjs'));
    result = await call('/api/skills/demo/exec', { method: 'POST', body: { command: 'node linked.mjs' } });
    assert.match(String(result.json.error), /outside the skill directory/);
  }
  assert.equal(existsSync(marker), false, 'nothing executed so far');

  resetCapabilityStateForTests();
  registerCapabilityPrompter(async () => 'allow-once');
  result = await call('/api/skills/demo/exec', { method: 'POST', body: { command: 'node run.mjs' } });
  assert.equal(result.json.ok, true, `approved command runs: ${result.text}`);
  assert.equal(existsSync(marker), true);
  assert.ok(auditLines.some((line) => line.includes('"process.exec"')), 'execution is audited');

  // ── 3. settings: credential redirection & data relocation ─────────────────
  resetCapabilityStateForTests();
  result = await call('/api/keys', { method: 'POST', body: { OPENAI_BASE_URL: 'https://collector.attacker.example/v1' } });
  assert.equal(result.status, 403, 'redirecting a stored key needs the user');
  assert.equal(getKey('OPENAI_BASE_URL' as never), '', 'setting unchanged after denial');
  result = await call('/api/keys', { method: 'POST', body: { PROXY_URL: 'http://collector.attacker.example:8080' } });
  assert.equal(result.status, 403, 'routing traffic through a new proxy needs the user');
  result = await call('/api/keys', { method: 'POST', body: { MEDIA_DIR: join(sandbox, 'elsewhere') } });
  assert.equal(result.status, 403, 'relocating the media library needs the user');
  result = await call('/api/keys', { method: 'POST', body: { OPENCHATCUT_SKILLS_DIR: join(sandbox, 'evil-skills') } });
  assert.equal(result.status, 403, 'relocating skills needs the user');
  result = await call('/api/keys/test', { method: 'POST', body: { page: 'llm/openai', overrides: { OPENAI_BASE_URL: 'https://collector.attacker.example/v1' } } });
  assert.equal(result.status, 403, 'testing a new endpoint with the STORED key needs the user');
  result = await call('/api/keys', { method: 'POST', body: { R2_ACCOUNT_ID: 'attacker-account' } });
  assert.equal(result.status, 403, 'R2_ACCOUNT_ID picks the host signed R2 requests go to');
  const keys = await call('/api/keys');
  assert.ok(!keys.text.includes('sk-test-stored-key'), 'stored secrets never reach the page');

  // ── 4. agent local paths ───────────────────────────────────────────────────
  const media = join(sandbox, 'media');
  mkdirSync(media, { recursive: true });
  writeFileSync(join(media, 'a.mp4'), 'x');
  await assert.rejects(resolveAgentMediaPath(join(media, 'a.mp4')), (error: { code?: string }) => error.code === 'IMPORT_ROOTS_NOT_CONFIGURED',
    'no granted folder → default deny');
  for (const hostile of ['\\\\attacker.example\\share\\a.mp4', '//attacker.example/share/a.mp4', '\\\\?\\C:\\secret.mp4']) {
    await assert.rejects(resolveAgentMediaPath(hostile), /not allowed|absolute/, hostile);
  }
  seedKeystore({ AGENT_IMPORT_ROOTS: media });
  assert.ok((await resolveAgentMediaPath(join(media, 'a.mp4'))).endsWith('a.mp4'), 'granted folder is reachable');
  await assert.rejects(resolveAgentMediaPath(join(sandbox, 'executed.marker')), (error: { code?: string }) => error.code === 'PATH_OUTSIDE_IMPORT_ROOTS');
  await assert.rejects(resolveAgentMediaPath(join(media, '..', 'executed.marker')), (error: { code?: string }) => error.code === 'PATH_OUTSIDE_IMPORT_ROOTS', 'traversal out of a granted folder');
  if (process.platform !== 'win32') {
    symlinkSync(join(sandbox, 'executed.marker'), join(media, 'escape.svg'));
    await assert.rejects(resolveAgentMediaPath(join(media, 'escape.svg')), (error: { code?: string }) => error.code === 'PATH_OUTSIDE_IMPORT_ROOTS', 'symlink escape');
  }

  // ── 5. CapCut export ───────────────────────────────────────────────────────
  const runs: string[][] = [];
  const fakeRun = async (args: string[]) => { runs.push(args); return { ok: false, error: 'stop' }; };
  const clip = { id: 'c', kind: 'video', src: join(media, 'a.mp4'), from: 0, durationInFrames: 30 };
  await exportJianyingDraft({ items: [clip], draftName: '--force-write=../../x' }, { run: fakeRun as never, probeDuration: async () => 1_000_000 });
  assert.ok(!String(runs.at(-1)?.[1]).startsWith('-'), 'draft name cannot become an option');
  assert.ok(!String(runs.at(-1)?.[1]).startsWith('.'), 'draft name cannot start with dots');
  const unc = await exportJianyingDraft({ items: [clip], draftsDir: '\\\\attacker.example\\drafts' }, { run: fakeRun as never, probeDuration: async () => 1_000_000 });
  assert.equal(unc.ok, false);
  assert.match(String(unc.error), /invalid drafts directory/);
  const uncSource = await exportJianyingDraft({ items: [{ ...clip, src: '\\\\attacker.example\\share\\a.mp4' }] }, { run: fakeRun as never });
  assert.equal(uncSource.ok, false, 'UNC clip sources are never opened');
  // Real (non-injected) exports need PROCESS_EXECUTION: default deny.
  resetCapabilityStateForTests();
  await assert.rejects(exportJianyingDraft({ items: [clip] }), /Permission denied/);

  console.log('privileged boundaries verify passed');
} finally {
  server.close();
  setAuditSinkForTests(null);
  resetCapabilityStateForTests();
  process.chdir(tmpdir());
  rmSync(sandbox, { recursive: true, force: true });
}
