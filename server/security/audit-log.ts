// Security audit log: an append-only JSON-lines record of privileged decisions
// (capability grants and denials, blocked navigation, rejected paths, process
// launches). It records WHAT was decided about WHICH capability, never secret
// values or file contents.
//
// Location: <OPENCHATCUT_AUDIT_LOG_DIR> when set (the desktop app points it at
// userData/logs), otherwise ~/.openchatcut/logs. Rotated at 5 MB, keeping one
// previous file. Writing is best effort: an unwritable log never blocks the app.
import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scrubInternalPaths } from '../error-scrub.ts';

export const AUDIT_LOG_DIR_ENV = 'OPENCHATCUT_AUDIT_LOG_DIR';
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_FIELD = 600;

export type AuditEvent =
  | 'capability.granted'
  | 'capability.denied'
  | 'capability.prompt'
  | 'process.exec'
  | 'process.blocked'
  | 'path.rejected'
  | 'navigation.blocked'
  | 'permission.denied'
  | 'permission.granted'
  | 'network.blocked'
  | 'mcp.tool'
  | 'ipc.rejected'
  | 'http.rejected';

export interface AuditRecord {
  readonly event: AuditEvent;
  readonly capability?: string;
  readonly action?: string;
  readonly requester?: string;
  readonly decision?: string;
  readonly target?: string;
  readonly detail?: string;
}

// Shapes that look like credentials. Anything matching is replaced before the
// record is written, even though callers are expected never to pass secrets.
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(sk|pk|rk|xai|gsk|hf|ghp|gho|ghs|github_pat|fal|r8|AIza)[-_][A-Za-z0-9_-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(api[_-]?key|token|secret|password|passwd|authorization|x-api-key)(["'\s:=]+)[^\s"'&,;]{4,}/gi,
  /\b[A-Fa-f0-9]{40,}\b/g,
  /\b[A-Za-z0-9+/]{48,}={0,2}/g,
  /(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
];

/** Remove anything credential-shaped and home-directory paths from `text`. */
export function redactForAudit(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, ...groups: unknown[]) => {
      if (pattern.source.startsWith('(https?')) return `${String(groups[0])}[redacted]@`;
      if (pattern.source.includes('api[_-]?key')) return `${String(groups[0])}${String(groups[1])}[redacted]`;
      return match.length > 0 ? '[redacted]' : match;
    });
  }
  out = scrubInternalPaths(out);
  return out.length > MAX_FIELD ? `${out.slice(0, MAX_FIELD)}…` : out;
}

export function auditLogDir(): string {
  const configured = process.env[AUDIT_LOG_DIR_ENV]?.trim();
  return configured || join(homedir(), '.openchatcut', 'logs');
}

export function auditLogPath(): string {
  return join(auditLogDir(), 'security-audit.log');
}

type AuditSink = (line: string) => void;
let testSink: AuditSink | null = null;

/** Tests capture records instead of touching the filesystem. */
export function setAuditSinkForTests(sink: AuditSink | null): void {
  testSink = sink;
}

export function audit(record: AuditRecord): void {
  const entry: Record<string, string> = { ts: new Date().toISOString(), event: record.event };
  for (const key of ['capability', 'action', 'requester', 'decision', 'target', 'detail'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value) entry[key] = redactForAudit(value);
  }
  const line = `${JSON.stringify(entry)}\n`;
  if (testSink) {
    testSink(line);
    return;
  }
  try {
    const dir = auditLogDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = auditLogPath();
    try {
      if (statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`);
    } catch {
      // Missing file: first write creates it.
    }
    appendFileSync(file, line, { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* best effort on Windows */ }
  } catch {
    // Audit logging must never take the app down.
  }
}
