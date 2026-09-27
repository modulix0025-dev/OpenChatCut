import { app, type BrowserWindow } from 'electron';
import { externalMcpToken } from '../server/editor-auth.ts';
import { runDesktopMcpRecoverySmoke } from './smoke-mcp-recovery.ts';
import { runDesktopRendererRecoverySmoke } from './smoke-renderer-recovery.ts';

const RENDER_DRAIN_MS = 500;
// Under the app's 240s watchdog, over any plausible healthy render (previous
// green runs finished the whole smoke in ~3 minutes).
const RENDER_DEADLINE_MS = 180_000;

export async function runDesktopSmokeProbe(
  origin: string,
  win: BrowserWindow,
  render: boolean,
  cookieHeader = '',
): Promise<void> {
  // The embedded server only answers the Electron session (desktop/embedded-request-gate.ts);
  // main-process probes present the same session cookie.
  const sessionHeaders: Record<string, string> = cookieHeader ? { Cookie: cookieHeader } : {};
  const res = await fetch(`${origin}/api/keys`, { headers: sessionHeaders });
  if (!res.ok) throw new Error(`/api/keys → HTTP ${res.status}`);
  const mcp = await fetch(`${origin}/api/external-mcp/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${externalMcpToken()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'desktop-smoke', version: '1' },
      },
    }),
  });
  if (!mcp.ok || !(await mcp.text()).includes('"name":"openchatcut"')) {
    throw new Error(`/api/external-mcp/mcp → HTTP ${mcp.status}`);
  }
  console.log('[smoke] external MCP endpoint ok');
  await runDesktopSecuritySmoke(origin, win, cookieHeader);
  if (process.env.CC_SMOKE_MCP_RECOVERY === '1') {
    await runDesktopMcpRecoverySmoke(origin, externalMcpToken());
  }
  const pickerType = await win.webContents.executeJavaScript(
    'typeof window.openChatCutDesktop?.selectDirectory',
  ) as unknown;
  if (pickerType !== 'function') throw new Error('desktop directory picker preload is unavailable');
  console.log('[smoke] desktop directory picker preload ok');
  const updaterType = await win.webContents.executeJavaScript(
    'typeof window.openChatCutDesktop?.updates?.check',
  ) as unknown;
  if (updaterType !== 'function') throw new Error('desktop updater preload is unavailable');
  console.log('[smoke] desktop updater preload ok');
  // Editor bridge heartbeat (issue #86): the long poll is timer-driven, so
  // background throttling must be off or minimizing the window drops the
  // MCP bridge offline. Assert the RUNTIME value, not just the source flag.
  const throttlingDisabled = win.webContents.getBackgroundThrottling();
  if (throttlingDisabled !== false) {
    throw new Error(`background throttling is enabled (${String(throttlingDisabled)}); the MCP bridge heartbeat will stall in background windows`);
  }
  console.log('[smoke] background throttling disabled (bridge heartbeat safe)');
  const inference = await win.webContents.executeJavaScript(
    'window.openChatCutDesktop?.inference?.getCapabilities()',
  ) as {
    version?: unknown;
    asr?: { available?: unknown };
    semantic?: { available?: unknown };
    clap?: { available?: unknown };
    rhythm?: { available?: unknown };
    hardware?: {
      cpu?: { logicalCores?: unknown; totalMemoryBytes?: unknown };
      gpus?: unknown;
      hardwareAcceleration?: unknown;
    };
  } | null;
  if (inference?.version !== 3
    || typeof inference.asr?.available !== 'boolean'
    || typeof inference.semantic?.available !== 'boolean'
    || typeof inference.clap?.available !== 'boolean'
    || typeof inference.rhythm?.available !== 'boolean'
    || !Array.isArray(inference.hardware?.gpus)
    || typeof inference.hardware?.cpu?.logicalCores !== 'number'
    || typeof inference.hardware?.cpu?.totalMemoryBytes !== 'number'
    || typeof inference.hardware?.hardwareAcceleration !== 'boolean') {
    throw new Error('desktop native inference preload is unavailable');
  }
  console.log('[smoke] desktop native inference preload ok');
  if (render) {
    // The render runs BEFORE the renderer-recovery phase: on the v0.2.12
    // windows-latest run the app wedged after the deliberate renderer crashes
    // so hard that neither the 240s watchdog's process.exit nor app.exit ran —
    // no log line, killed externally at 420s. Destructive probes go last so
    // the release-gating render is not downstream of them, and the fetch
    // carries its own deadline so a slow or stuck render names itself instead
    // of relying on the watchdog.
    console.log('[smoke] render-still starting');
    const state = { fps: 30, width: 640, height: 360, items: [], selectedId: null };
    const response = await fetch(`${origin}/render-still`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        'Sec-Fetch-Site': 'same-origin',
        ...sessionHeaders,
      },
      body: JSON.stringify({ state, frames: [0] }),
      signal: AbortSignal.timeout(RENDER_DEADLINE_MS),
    });
    if (!response.ok) {
      throw new Error(`/render-still → HTTP ${response.status}: ${await response.text()}`);
    }
    const rendered = (await response.json()) as { frames?: Array<{ base64?: string }> };
    if (!rendered.frames?.[0]?.base64) throw new Error('/render-still returned no frame');
    console.log(`[smoke] render-still ok, base64 ${rendered.frames[0].base64.length}B`);
    // Remotion can emit late DevTools protocol callbacks after the response.
    await new Promise((resolve) => setTimeout(resolve, RENDER_DRAIN_MS));
  }
  if (process.env.CC_SMOKE_RENDERER_RECOVERY === '1') {
    await runDesktopRendererRecoverySmoke(win);
  }
}

/**
 * The hardening must hold in the packaged app, not just in unit tests:
 * front-door gate, no Node in the page, CSP blocking injected script, no
 * popups. Runs in every packaged smoke (CI Windows/macOS/Linux).
 */
async function runDesktopSecuritySmoke(origin: string, win: BrowserWindow, cookieHeader: string): Promise<void> {
  if (cookieHeader) {
    const anonymous = await fetch(`${origin}/api/keys`);
    if (anonymous.status !== 403) throw new Error(`embedded server answered a request without the session cookie (HTTP ${anonymous.status})`);
  }
  const page = await win.webContents.executeJavaScript(`(() => {
    const script = document.createElement('script');
    script.textContent = 'window.__occCspProbe = 1';
    document.head.appendChild(script);
    script.remove();
    let popup = null;
    try { popup = window.open('about:blank', '_blank'); } catch {}
    return {
      node: typeof require !== 'undefined' || typeof process !== 'undefined' || typeof module !== 'undefined',
      inlineScriptRan: window.__occCspProbe === 1,
      popup: Boolean(popup),
      bridgeKeys: Object.keys(window.openChatCutDesktop ?? {}).length,
    };
  })()`) as { node: boolean; inlineScriptRan: boolean; popup: boolean; bridgeKeys: number };
  if (page.node) throw new Error('Node.js globals are reachable from the editor page');
  if (app.isPackaged && page.inlineScriptRan) throw new Error('Content-Security-Policy did not block an injected inline script');
  if (page.popup) throw new Error('window.open created a popup');
  if (!page.bridgeKeys) throw new Error('desktop bridge missing');
  console.log('[smoke] security boundaries ok (session gate, no Node, CSP, no popups)');
}
