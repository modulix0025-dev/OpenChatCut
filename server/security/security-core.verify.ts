// Security regression suite for the core security modules: local path
// validation, the capability broker (default deny, scoping, persistence,
// prompt flooding) and audit-log redaction.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertSafeLocalPath,
  isSafeFileNameSegment,
  isSafeLocalPath,
  unsafeLocalPathReason,
} from './local-path-safety.ts';
import {
  CapabilityDeniedError,
  developmentCapabilityPrompter,
  displaySafeText,
  listPersistedCapabilityGrants,
  registerCapabilityPrompter,
  requireCapability,
  resetCapabilityStateForTests,
  revokeAllCapabilityGrants,
  SECURITY_DIR_ENV,
  type CapabilityDecision,
  type CapabilityRequest,
} from './capabilities.ts';
import { audit, redactForAudit, setAuditSinkForTests } from './audit-log.ts';
import { capabilityDialogChoices, capabilityDialogDetail, capabilityDialogOptions } from '../../desktop/capability-dialog.ts';

// ── local path safety ────────────────────────────────────────────────────────
const rejected: Array<[string, NodeJS.Platform, string]> = [
  ['\\\\attacker.example\\share\\a.mp4', 'win32', 'unc-path'],
  ['//attacker.example/share/a.mp4', 'linux', 'unc-path'],
  ['\\\\?\\C:\\Windows\\System32\\config\\SAM', 'win32', 'device-path'],
  ['\\\\.\\PhysicalDrive0', 'win32', 'device-path'],
  ['\\??\\C:\\x', 'win32', 'device-path'],
  ['C:\\Users\\me\\video.mp4:hidden', 'win32', 'alternate-data-stream'],
  ['C:\\Users\\me\\video.mp4::$DATA', 'win32', 'alternate-data-stream'],
  ['C:\\Users\\me\\CON', 'win32', 'reserved-device-name'],
  ['C:\\Users\\me\\nul.txt', 'win32', 'reserved-device-name'],
  ['C:\\Users\\me\\COM1.mp4', 'win32', 'reserved-device-name'],
  ['C:\\Users\\me\\evil.', 'win32', 'trailing-dot-or-space'],
  ['C:\\Users\\me\\evil ', 'win32', 'trailing-dot-or-space'],
  ['C:relative\\x.mp4', 'win32', 'not-absolute'],
  ['\\rooted\\x.mp4', 'win32', 'not-absolute'],
  ['relative/x.mp4', 'linux', 'not-absolute'],
  ['../../etc/passwd', 'linux', 'not-absolute'],
  ['/tmp/a\u0000.mp4', 'linux', 'control-character'],
  ['/tmp/a\n.mp4', 'linux', 'control-character'],
  ['file:///etc/passwd', 'linux', 'url'],
  ['smb://host/share', 'linux', 'url'],
  ['', 'linux', 'empty'],
  [`/${'a'.repeat(5000)}`, 'linux', 'too-long'],
];
for (const [path, platform, reason] of rejected) {
  assert.equal(unsafeLocalPathReason(path, platform), reason, `${JSON.stringify(path)} on ${platform}`);
  assert.throws(() => assertSafeLocalPath(path, platform));
}
for (const [path, platform] of [
  ['C:\\Users\\me\\Videos\\clip.mp4', 'win32'],
  ['D:/Media/Project 1/clip.mov', 'win32'],
  ['/home/me/Videos/clip.mp4', 'linux'],
  ['/Users/me/Movies/片段.mov', 'darwin'],
] as const) {
  assert.ok(isSafeLocalPath(path, platform), `${path} should be accepted`);
}
assert.equal(isSafeLocalPath(42), false);
for (const name of ['..', '.', 'a/b', 'a\\b', 'CON', 'x:y', 'x.', 'a\u0001b', '']) {
  assert.equal(isSafeFileNameSegment(name), false, `segment ${JSON.stringify(name)}`);
}
assert.ok(isSafeFileNameSegment('clip 01.mp4'));

// ── audit log redaction ──────────────────────────────────────────────────────
const lines: string[] = [];
setAuditSinkForTests((line) => lines.push(line));
const secrets = [
  'sk-proj-abcdefghijklmnopqrstuvwxyz123456',
  'Bearer abcdefghijklmnopqrstuvwxyz0123456789',
  'api_key=supersecretvalue123',
  'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  'http://user:hunter2@proxy.example:8080',
  'AIzaSyA1234567890abcdefghijklmnopqrstuv',
];
for (const secret of secrets) {
  const redacted = redactForAudit(`value ${secret} end`);
  assert.ok(!redacted.includes('hunter2'), redacted);
  assert.ok(!/abcdefghijklmnopqrstuvwxyz/.test(redacted), `not redacted: ${redacted}`);
  assert.ok(!redacted.includes('supersecretvalue123'), redacted);
}
audit({ event: 'capability.denied', capability: 'PROCESS_EXECUTION', detail: 'token: abcdefghijklmnop1234' });
assert.equal(lines.length, 1);
const logged = JSON.parse(lines[0]!) as Record<string, string>;
assert.equal(logged.event, 'capability.denied');
assert.ok(!logged.detail!.includes('abcdefghijklmnop1234'));

// ── capability broker ────────────────────────────────────────────────────────
const securityDir = mkdtempSync(join(tmpdir(), 'occ-capabilities-'));
process.env[SECURITY_DIR_ENV] = securityDir;
resetCapabilityStateForTests();
const request = (overrides: Partial<CapabilityRequest> = {}): CapabilityRequest => ({
  capability: 'PROCESS_EXECUTION',
  action: 'skill.exec',
  summary: 'run a program',
  detail: 'Command: node run.mjs',
  scopeKey: 'skill.exec:demo:node run.mjs',
  requester: 'agent',
  ...overrides,
});

// 1. No prompter → default deny, and the denial is audited.
lines.length = 0;
await assert.rejects(requireCapability(request()), CapabilityDeniedError);
assert.ok(lines.some((line) => line.includes('deny-no-prompter')));

// 2. Explicit decisions.
const asked: CapabilityRequest[] = [];
let answer: CapabilityDecision = 'deny';
const unregister = registerCapabilityPrompter(async (req) => { asked.push(req); return answer; });
await assert.rejects(requireCapability(request()), CapabilityDeniedError);
assert.equal(asked.length, 1);
// Denial cooldown: an immediate retry of the same scope does not re-prompt (no dialog flooding).
await assert.rejects(requireCapability(request()), CapabilityDeniedError);
assert.equal(asked.length, 1, 'a recently denied scope must not prompt again');

answer = 'allow-once';
await requireCapability(request({ scopeKey: 'once' }));
await requireCapability(request({ scopeKey: 'once' }));
assert.equal(asked.filter((req) => req.scopeKey === 'once').length, 2, 'allow-once must not be remembered');

answer = 'allow-session';
await requireCapability(request({ scopeKey: 'session' }));
answer = 'deny';
await requireCapability(request({ scopeKey: 'session' }));
assert.equal(asked.filter((req) => req.scopeKey === 'session').length, 1, 'session grant is reused');
// Scoping: the session grant for one command does not cover another command or capability.
await assert.rejects(requireCapability(request({ scopeKey: 'session-other' })), CapabilityDeniedError);
await assert.rejects(requireCapability(request({ scopeKey: 'session', capability: 'FILES_WRITE' })), CapabilityDeniedError);

// Non-rememberable requests are never stored even when the user picks "always".
answer = 'allow-always';
await requireCapability(request({ scopeKey: 'never-remember', rememberable: false }));
answer = 'deny';
await assert.rejects(requireCapability(request({ scopeKey: 'never-remember', rememberable: false })), CapabilityDeniedError);

// Always-allow persists with owner-only permissions and survives a restart.
answer = 'allow-always';
await requireCapability(request({ scopeKey: 'always' }));
const grantsFile = join(securityDir, 'capability-grants.json');
assert.ok(JSON.parse(readFileSync(grantsFile, 'utf8')).grants.some((grant: { scopeKey: string }) => grant.scopeKey === 'always'));
if (process.platform !== 'win32') assert.equal(statSync(grantsFile).mode & 0o777, 0o600);
unregister();
resetCapabilityStateForTests();
await requireCapability(request({ scopeKey: 'always' })); // no prompter, persisted grant still applies

// Project grants only apply to that project.
registerCapabilityPrompter(async () => 'allow-project');
await requireCapability(request({ scopeKey: 'proj', projectId: 'p1' }));
resetCapabilityStateForTests();
await requireCapability(request({ scopeKey: 'proj', projectId: 'p1' }));
await assert.rejects(requireCapability(request({ scopeKey: 'proj', projectId: 'p2' })), CapabilityDeniedError);

// Revoking clears everything.
revokeAllCapabilityGrants();
assert.equal(listPersistedCapabilityGrants().length, 0);
await assert.rejects(requireCapability(request({ scopeKey: 'always' })), CapabilityDeniedError);

// Prompts are serialized: concurrent requests never open two dialogs at once.
resetCapabilityStateForTests();
let open = 0;
let maxOpen = 0;
registerCapabilityPrompter(async () => {
  open += 1;
  maxOpen = Math.max(maxOpen, open);
  await new Promise((resolve) => setTimeout(resolve, 5));
  open -= 1;
  return 'allow-once';
});
await Promise.all([1, 2, 3, 4].map((n) => requireCapability(request({ scopeKey: `parallel-${n}` }))));
assert.equal(maxOpen, 1);

// Dev-server policy: allow with a log line, or deny when configured.
resetCapabilityStateForTests();
const devLog: string[] = [];
registerCapabilityPrompter(developmentCapabilityPrompter((line) => devLog.push(line)));
await requireCapability(request({ scopeKey: 'dev' }));
assert.equal(devLog.length, 1);
process.env.OPENCHATCUT_CAPABILITY_POLICY = 'deny';
registerCapabilityPrompter(developmentCapabilityPrompter(() => undefined));
await assert.rejects(requireCapability(request({ scopeKey: 'dev-deny' })), CapabilityDeniedError);
delete process.env.OPENCHATCUT_CAPABILITY_POLICY;

// ── what the dialog shows ────────────────────────────────────────────────────
// Bidi overrides and controls cannot disguise a name ("gpj.exe" shown as "exe.jpg").
assert.equal(displaySafeText('evil\u202Egpj.exe\u0007'), 'evilgpj.exe');
assert.equal(displaySafeText('a\u2066b\u2069c\u200Fd'), 'abcd');
const baseRequest = request({ scopeKey: 'dialog' });
assert.deepEqual(capabilityDialogChoices(baseRequest).map((choice) => choice.decision),
  ['deny', 'allow-once', 'allow-session', 'allow-always']);
assert.equal(capabilityDialogOptions(baseRequest).defaultId, 0, 'Deny is the default button');
assert.equal(capabilityDialogOptions(baseRequest).cancelId, 0, 'Esc / close means Deny');
assert.deepEqual(capabilityDialogChoices(request({ projectId: 'p' })).map((choice) => choice.decision),
  ['deny', 'allow-once', 'allow-session', 'allow-project', 'allow-always']);
assert.deepEqual(capabilityDialogChoices(request({ rememberable: false })).map((choice) => choice.decision), ['deny', 'allow-once']);
assert.deepEqual(capabilityDialogChoices(request({ maxRemember: 'session' })).map((choice) => choice.decision), ['deny', 'allow-once', 'allow-session']);
// A detail too long to show in full keeps head and tail and offers no "remember".
const long = `Command: cp ${'benign '.repeat(400)}HIDDEN_TAIL_ARG`;
const shown = capabilityDialogDetail(long);
assert.ok(shown.elided && shown.text.includes('HIDDEN_TAIL_ARG') && shown.text.includes('characters not shown'));
assert.deepEqual(capabilityDialogChoices(request({ detail: long })).map((choice) => choice.decision), ['deny', 'allow-once']);
// Session-capped grants are never persisted, whatever the prompter answers.
resetCapabilityStateForTests();
registerCapabilityPrompter(async () => 'allow-always');
await requireCapability(request({ scopeKey: 'session-capped', maxRemember: 'session' }));
assert.ok(!listPersistedCapabilityGrants().some((grant) => grant.scopeKey === 'session-capped'));
resetCapabilityStateForTests();
await assert.rejects(requireCapability(request({ scopeKey: 'session-capped', maxRemember: 'session' })), CapabilityDeniedError,
  'a session-capped grant does not survive a restart');

// ── executable allowlisting in packaged builds ───────────────────────────────
process.env.FFMPEG_PATH = '/planted/ffmpeg';
process.env.OPENCHATCUT_FFMPEG = '/planted/ffmpeg';
process.env.FFPROBE_PATH = '/planted/ffprobe';
process.env.OPENCHATCUT_WHISPER_CLI = '/planted/whisper';
const binaries = await import('../media-binaries.ts');
assert.equal(binaries.ffmpegBin(), '/planted/ffmpeg', 'source checkouts keep the developer override');
process.env[binaries.PACKAGED_RUNTIME_ENV] = '1';
process.env.FFMPEG_BIN = '/planted/ffmpeg-bin';
process.env.npm_config_platform = 'freebsd';
for (const [name, value] of [['ffmpeg', binaries.ffmpegBin()], ['ffprobe', binaries.ffprobeBin()], ['whisper', binaries.whisperCliBin()]] as const) {
  assert.ok(!value.includes('/planted/'), `packaged ${name} must ignore environment overrides (got ${value})`);
}
for (const name of ['FFMPEG_PATH', 'OPENCHATCUT_FFMPEG', 'FFPROBE_PATH', 'OPENCHATCUT_WHISPER_CLI', 'FFMPEG_BIN', 'npm_config_platform', binaries.PACKAGED_RUNTIME_ENV]) {
  delete process.env[name];
}

resetCapabilityStateForTests();
setAuditSinkForTests(null);
rmSync(securityDir, { recursive: true, force: true });
console.log('security core verify passed');
