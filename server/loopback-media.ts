// Media referenced by a loopback URL (127.0.0.1 / localhost / ::1).
//
// Export materializes remote media through safePublicFetch, which refuses
// private hosts and non-standard ports so a project cannot make the server
// probe the machine or the LAN. Two loopback cases are legitimate, though:
// - the app's own upload URL (http://127.0.0.1:<port>/media/uploads/x.mp3),
//   which is just a local file and is mapped back to its path, no request;
// - a local generation service such as ComfyUI (http://127.0.0.1:8188/view…),
//   downloaded only after the user allows that host:port in the native
//   permission dialog, without following redirects.
// Private LAN addresses stay refused.
import { requireCapability, type CapabilityRequester } from './security/capabilities.ts';

export type LoopbackMedia =
  | { readonly kind: 'app-upload'; readonly path: string }
  | { readonly kind: 'service'; readonly url: URL };

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function classifyLoopbackMediaUrl(source: string): LoopbackMedia | null {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) return null;
  if (url.pathname.startsWith('/media/uploads/') && !url.pathname.includes('..')) {
    return { kind: 'app-upload', path: url.pathname };
  }
  return { kind: 'service', url };
}

/** Fetch from a loopback service after the user allows that host:port. */
export async function loopbackMediaFetch(
  source: string,
  init: RequestInit = {},
  requester: CapabilityRequester = 'editor',
): Promise<Response> {
  const media = classifyLoopbackMediaUrl(source);
  if (media?.kind !== 'service') throw new Error(`not a loopback service URL: ${source}`);
  const origin = `${media.url.hostname}:${media.url.port || (media.url.protocol === 'https:' ? '443' : '80')}`;
  await requireCapability({
    capability: 'NETWORK_ACCESS',
    action: 'media.loopback-download',
    summary: `Download media from a service running on this computer (${origin}) to use it in the export.`,
    detail: source,
    scopeKey: `network.loopback:${origin}`,
    requester,
  });
  return fetch(media.url, { ...init, redirect: 'error' });
}
