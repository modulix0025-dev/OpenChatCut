// Front door of the desktop embedded server (127.0.0.1). Runs before any route.
//
// 1. Host allowlist: only 127.0.0.1:<port> / localhost:<port> / [::1]:<port>.
//    A DNS-rebinding page reaches the socket with its own hostname in Host and
//    is refused here, including on GET routes that have no guard of their own.
// 2. Session secret: every request must carry the per-launch HttpOnly cookie
//    that only the Electron session holds (desktop/security-policy.ts). This
//    shuts out other local processes and other OS users sharing loopback.
//    Two routes authenticate differently and are passed through to their own
//    checks: the external MCP endpoint (bearer token) and the phone upload
//    hand-off (single-use token issued by the mobile upload session).
// 3. Anti-framing and no-sniff headers on every response.
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { audit } from '../server/security/audit-log.ts';

export const DESKTOP_SESSION_COOKIE = 'occ_desktop_session';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function allowedHostHeader(host: string | undefined, port: number): boolean {
  if (!host || /[/\\@?#,\s]/.test(host)) return false;
  const match = host.toLowerCase().match(/^(\[::1\]|[a-z0-9.-]+)(?::(\d+))?$/);
  if (!match) return false;
  return LOOPBACK_HOSTS.has(match[1]!) && Number(match[2]) === port;
}

export function readCookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

function secretMatches(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Routes that carry their own credential and must stay reachable without the cookie. */
export function isSelfAuthenticatedRoute(req: IncomingMessage): boolean {
  const url = req.url ?? '/';
  const path = url.split('?')[0] ?? '/';
  if (path === '/api/external-mcp/mcp' || path.startsWith('/api/external-mcp/mcp/')) {
    return typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ');
  }
  if (path === '/upload' && /[?&]handoff=/.test(url)) return true;
  return false;
}

export interface EmbeddedRequestGateOptions {
  readonly port: () => number;
  /** When null, only the Host check runs (tests, isolated tooling). */
  readonly sessionSecret: string | null;
}

export function embeddedRequestGate(options: EmbeddedRequestGateOptions) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const deny = (reason: string): void => {
      audit({ event: 'http.rejected', action: `${req.method ?? 'GET'} ${(req.url ?? '/').split('?')[0]}`, detail: reason });
      req.resume();
      res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'forbidden' }));
    };
    if (!allowedHostHeader(req.headers.host, options.port())) {
      deny('host not allowed');
      return;
    }
    if (options.sessionSecret === null || isSelfAuthenticatedRoute(req)) {
      next();
      return;
    }
    if (!secretMatches(readCookie(req, DESKTOP_SESSION_COOKIE), options.sessionSecret)) {
      deny('missing or invalid desktop session');
      return;
    }
    next();
  };
}
