// Production Electron security policy: everything the main process enforces
// on web content, independent of which window loads it.
//
//  - Content-Security-Policy on every document served by the embedded origin
//    (no inline or remote script, no plugins, no framing, no <base> rewrite).
//  - A per-launch session secret, delivered only as an HttpOnly cookie to the
//    editor origin, that the embedded server requires on every request. Other
//    local processes, other OS users on the machine and DNS-rebinding pages
//    never see it (desktop/embedded-request-gate.ts).
//  - Default-deny browser permissions; the microphone and clipboard reads go
//    through the capability broker's native prompt.
//  - No <webview>, no popups, no navigation away from the editor origin in any
//    web contents, including ones created later.
import { randomBytes } from 'node:crypto';
import { app, session, type Session, type WebContents } from 'electron';
import { requireCapability } from '../server/security/capabilities.ts';
import { audit } from '../server/security/audit-log.ts';
import { DESKTOP_SESSION_COOKIE } from './embedded-request-gate.ts';
import { editorContentSecurityPolicy } from './content-security-policy.ts';

export { DESKTOP_SESSION_COOKIE, editorContentSecurityPolicy };

/** Permissions the editor may use without asking. Everything else is denied or prompted. */
const SILENT_PERMISSIONS: ReadonlySet<string> = new Set([
  'clipboard-sanitized-write',
  'fullscreen',
  // The File System Access picker only yields what the user picks in a native dialog.
  'fileSystem',
]);

function isTrustedUrl(url: string | undefined, origin: string): boolean {
  if (!url) return false;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

export interface DesktopSecurityPolicy {
  readonly sessionSecret: string;
  /** Cookie header value main-process fetches (smoke probe) must send. */
  readonly cookieHeader: string;
}

export function createDesktopSessionSecret(): string {
  return randomBytes(32).toString('base64url');
}

async function promptedPermission(permission: string, mediaTypes: readonly string[]): Promise<boolean> {
  try {
    if (permission === 'media') {
      if (mediaTypes.length === 0 || mediaTypes.some((type) => type !== 'audio')) return false;
      await requireCapability({
        capability: 'MEDIA_CAPTURE',
        action: 'microphone',
        requester: 'editor',
        summary: 'use your microphone to record a voice-over',
        scopeKey: 'microphone',
      });
      return true;
    }
    if (permission === 'clipboard-read') {
      await requireCapability({
        capability: 'CLIPBOARD',
        action: 'clipboard.read',
        requester: 'editor',
        summary: 'read the contents of your clipboard',
        scopeKey: 'clipboard.read',
      });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function applySessionPermissions(target: Session, origin: string): void {
  target.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const requestingUrl = 'requestingUrl' in details ? details.requestingUrl : undefined;
    if (!isTrustedUrl(requestingUrl, origin)) {
      audit({ event: 'permission.denied', action: permission, target: requestingUrl, detail: 'untrusted origin' });
      callback(false);
      return;
    }
    if (SILENT_PERMISSIONS.has(permission)) {
      callback(true);
      return;
    }
    const mediaTypes = 'mediaTypes' in details && Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
    void promptedPermission(permission, mediaTypes).then((granted) => {
      audit({ event: granted ? 'permission.granted' : 'permission.denied', action: permission });
      callback(granted);
    });
  });
  target.setPermissionCheckHandler((_contents, permission, requestingOrigin) => (
    isTrustedUrl(requestingOrigin, origin) && (SILENT_PERMISSIONS.has(permission) || permission === 'media')
  ));
  target.setDevicePermissionHandler(() => false);
  target.on('select-hid-device', (event, _details, callback) => { event.preventDefault(); callback(''); });
  target.on('select-serial-port', (event, _ports, _contents, callback) => { event.preventDefault(); callback(''); });
  target.on('select-usb-device', (event, _details, callback) => { event.preventDefault(); callback(); });
  target.on('will-download', (event, item) => {
    // Downloads started by page script land in a user-chosen location only
    // (Electron shows a save dialog when no path is preset); log them.
    audit({ event: 'network.blocked', action: 'download', target: item.getURL(), detail: 'download requested' });
    void event;
  });
}

function applyContentSecurityPolicy(target: Session, origin: string): void {
  const csp = editorContentSecurityPolicy();
  target.webRequest.onHeadersReceived((details, callback) => {
    if (!isTrustedUrl(details.url, origin)) {
      callback({});
      return;
    }
    const headers = { ...details.responseHeaders };
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'content-security-policy') delete headers[key];
    }
    headers['Content-Security-Policy'] = [csp];
    headers['X-Content-Type-Options'] = ['nosniff'];
    headers['Referrer-Policy'] = ['no-referrer'];
    callback({ responseHeaders: headers });
  });
}

function guardWebContents(contents: WebContents, origin: string): void {
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
    audit({ event: 'navigation.blocked', action: 'webview', detail: 'webview attach refused' });
  });
  contents.setWindowOpenHandler(({ url }) => {
    audit({ event: 'navigation.blocked', action: 'window.open', target: url });
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (isTrustedUrl(url, origin)) return;
    event.preventDefault();
    audit({ event: 'navigation.blocked', action: 'will-navigate', target: url });
  });
  if (app.isPackaged) {
    contents.on('devtools-opened', () => contents.closeDevTools());
  }
}

/**
 * Install the policy for `origin`. Call once, after the embedded server is
 * listening and before any window loads it. `enforceCsp` is false only for
 * the live Vite dev server, whose HMR client needs inline script.
 */
export async function installDesktopSecurityPolicy(options: {
  readonly origin: string;
  readonly sessionSecret: string;
  readonly enforceCsp: boolean;
}): Promise<DesktopSecurityPolicy> {
  const { origin, sessionSecret, enforceCsp } = options;
  const target = session.defaultSession;
  applySessionPermissions(target, origin);
  if (enforceCsp) applyContentSecurityPolicy(target, origin);
  app.on('web-contents-created', (_event, contents) => guardWebContents(contents, origin));
  for (const contents of (await import('electron')).webContents.getAllWebContents()) {
    guardWebContents(contents, origin);
  }
  // Session cookie (no expiry → never written to disk), HttpOnly so page
  // script cannot read it, SameSite=Strict so no other site can send it.
  await target.cookies.set({
    url: origin,
    name: DESKTOP_SESSION_COOKIE,
    value: sessionSecret,
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
  });
  return { sessionSecret, cookieHeader: `${DESKTOP_SESSION_COOKIE}=${sessionSecret}` };
}
