// Security regression suite for the Electron shell: window hardening, IPC
// sender validation, navigation policy, CSP, preload surface, packaging fuses
// and least-privilege installer settings. Static where the property is a
// configuration (the packaged app cannot be launched in CI on every host),
// behavioral where a pure function exists.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { editorContentSecurityPolicy } from './content-security-policy.ts';
import { assertTrustedDesktopSenderUrl, resolveDesktopDevOrigin, resolveDesktopPageUrlDecision } from './page-origin.ts';

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');
const main = await read('./main.ts');

// ── BrowserWindow hardening: every window, no exceptions ────────────────────
const windows = main.match(/new BrowserWindow\(\{[\s\S]*?\n {2,4}\}\);/g) ?? [];
assert.ok(windows.length >= 2, 'main and transcript windows');
for (const block of windows) {
  for (const required of [
    'contextIsolation: true',
    'nodeIntegration: false',
    'nodeIntegrationInWorker: false',
    'nodeIntegrationInSubFrames: false',
    'sandbox: true',
    'webSecurity: true',
    'allowRunningInsecureContent: false',
    'webviewTag: false',
    'devTools: !app.isPackaged',
  ]) {
    assert.ok(block.includes(required), `every BrowserWindow must set ${required}`);
  }
}
for (const forbidden of [/webSecurity:\s*false/, /nodeIntegration:\s*true/, /contextIsolation:\s*false/, /sandbox:\s*false/, /enableRemoteModule/, /remote-debugging-port/, /openDevTools\(/]) {
  assert.doesNotMatch(main, forbidden, `main.ts must not contain ${forbidden}`);
}
assert.match(main, /registerCapabilityPrompter\(createNativeCapabilityPrompter/, 'desktop registers the native permission prompt');
assert.match(main, /installDesktopSecurityPolicy\(\{/, 'desktop installs the session security policy');
assert.match(main, /startEmbeddedServer\(DIST_DIR, \{ sessionSecret \}\)/, 'embedded server requires the session secret');
assert.match(main, /process\.env\[PACKAGED_RUNTIME_ENV\] = '1'/, 'packaged builds pin bundled binaries');

// ── IPC: every handler validates its sender frame ───────────────────────────
for (const file of (await readdir(new URL('.', import.meta.url))).filter((name) => name.endsWith('.ts') && !name.includes('.verify.'))) {
  const source = await read(`./${file}`);
  const handlers = source.match(/ipcMain\.(handle|on)\(/g)?.length ?? 0;
  if (!handlers) continue;
  const guarded = (source.match(/assertTrustedDesktopSenderUrl\(|trustedDesktopHandler\(|\.assertTrusted\(event\)/g)?.length ?? 0);
  assert.ok(guarded >= handlers, `${file}: ${handlers} IPC handlers but only ${guarded} sender checks`);
}
const origin = 'http://127.0.0.1:5199';
assert.doesNotThrow(() => assertTrustedDesktopSenderUrl(`${origin}/#/editor/x`, origin));
for (const sender of ['http://127.0.0.1:5200/', 'https://evil.example/', 'file:///C:/x.html', 'about:blank', 'data:text/html,x', '', 'http://user:pw@127.0.0.1:5199/']) {
  assert.throws(() => assertTrustedDesktopSenderUrl(sender, origin), `IPC from ${sender || '(empty)'} must be rejected`);
}

// ── navigation policy ────────────────────────────────────────────────────────
assert.deepEqual(resolveDesktopPageUrlDecision(`${origin}/x`, origin, 'navigation'), { action: 'allow' });
assert.deepEqual(resolveDesktopPageUrlDecision(`${origin}/x`, origin, 'popup'), { action: 'deny' }, 'no in-app popups');
for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<script>1</script>', 'vbscript:x', 'ms-msdt:/id', 'search-ms:query=x', 'smb://host/share', 'https://user:pw@evil.example/']) {
  assert.deepEqual(resolveDesktopPageUrlDecision(url, origin, 'navigation'), { action: 'deny' }, `${url} must never navigate or open`);
  assert.deepEqual(resolveDesktopPageUrlDecision(url, origin, 'popup'), { action: 'deny' }, `${url} must never open externally`);
}
assert.deepEqual(resolveDesktopPageUrlDecision('https://docs.example/', origin, 'navigation'), { action: 'open-external', url: 'https://docs.example/' },
  'http(s) links leave the privileged renderer for the system browser');
assert.equal(resolveDesktopDevOrigin({ configuredDevUrl: 'http://127.0.0.1:5173', packaged: true, smoke: false }), null, 'packaged builds ignore the dev-server URL');
assert.throws(() => resolveDesktopDevOrigin({ configuredDevUrl: 'http://evil.example:5173', packaged: false, smoke: false }));

// ── CSP ─────────────────────────────────────────────────────────────────────
const csp = editorContentSecurityPolicy();
const directive = (name: string) => csp.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name} `)) ?? '';
assert.ok(directive('script-src'), 'script-src present');
assert.doesNotMatch(directive('script-src'), /'unsafe-inline'|https?:|\*|data:/, 'no inline, remote or data: script');
assert.equal(directive('object-src'), "object-src 'none'");
assert.equal(directive('frame-ancestors'), "frame-ancestors 'none'");
assert.equal(directive('base-uri'), "base-uri 'self'");
assert.equal(directive('form-action'), "form-action 'self'");
assert.doesNotMatch(directive('connect-src'), /http:/, 'no plain-http fetches (other loopback services) from the renderer');
const policy = await read('./security-policy.ts');
assert.match(policy, /setPermissionRequestHandler/);
assert.match(policy, /setPermissionCheckHandler/);
assert.match(policy, /setDevicePermissionHandler\(\(\) => false\)/);
assert.match(policy, /will-attach-webview/);
assert.match(policy, /httpOnly: true/);
assert.match(policy, /sameSite: 'strict'/);

// ── preload: one namespaced, typed API; no raw ipcRenderer ──────────────────
const preload = await read('./preload.ts');
assert.equal(preload.match(/exposeInMainWorld\(/g)?.length, 1, 'exactly one exposed API');
assert.doesNotMatch(preload, /exposeInMainWorld\([^)]*ipcRenderer\s*\)/, 'ipcRenderer itself is never exposed');
assert.doesNotMatch(preload, /invoke:\s*\(\s*channel/, 'no generic channel pass-through');
assert.doesNotMatch(preload, /\brequire\(|child_process|node:fs/, 'preload uses no Node APIs');

// ── packaging: fuses and least privilege ────────────────────────────────────
const config = (await import(new URL('../config/electron-builder.config.mjs', import.meta.url).href) as { default: Record<string, any> }).default;
assert.deepEqual(config.electronFuses, {
  runAsNode: false,
  enableCookieEncryption: true,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
  grantFileProtocolExtraPrivileges: false,
});
assert.equal(config.asar, true);
assert.equal(config.win.requestedExecutionLevel, 'asInvoker', 'the app never requests elevation');
assert.equal(config.nsis.perMachine, false, 'default install is per-user (no UAC)');
assert.equal(config.nsis.deleteAppDataOnUninstall, false, 'uninstall never deletes user projects by default');
for (const resource of config.extraResources as Array<{ from: string; filter?: string[] }>) {
  if (resource.from === 'dist' || resource.from === 'desktop-dist/remotion-bundle') {
    assert.ok(resource.filter?.includes('!**/*.map'), `${resource.from} must not ship source maps`);
  }
}
assert.ok(!(config.files as string[]).some((entry) => entry.endsWith('.map')), 'main bundles ship without maps');
const pkg = JSON.parse(await read('../package.json')) as { openchatcut?: { directUpdates?: boolean } };
assert.equal(pkg.openchatcut?.directUpdates, false, 'unsigned builds must not self-update in place');

console.log('electron security verify passed');
