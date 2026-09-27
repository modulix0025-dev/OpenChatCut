// Persistent application log for the packaged app, where devtools are off:
// <userData>/logs/app.log, rotated at 5 MB with 4 older files kept. It
// records the main process and embedded server (console.*), renderer console
// messages and crashes, and failed ffmpeg/ffprobe runs with their stderr
// (server/media-process.ts logs those through console.error). Obvious
// credentials are redacted before anything is written.
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';
import type { WebContents } from 'electron';
import { redactSecrets } from '../server/security/audit-log.ts';

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP_FILES = 4;
const MAX_LINE = 16_384;

let logFile: string | null = null;
let written = 0;

export function appLogPath(): string | null {
  return logFile;
}

function rotate(file: string): void {
  rmSync(`${file}.${KEEP_FILES}`, { force: true });
  for (let index = KEEP_FILES - 1; index >= 1; index -= 1) {
    if (existsSync(`${file}.${index}`)) renameSync(`${file}.${index}`, `${file}.${index + 1}`);
  }
  if (existsSync(file)) renameSync(file, `${file}.1`);
  written = 0;
}

/** Append one line; logging must never break the app, so failures are swallowed. */
export function writeAppLog(level: string, message: string): void {
  if (!logFile) return;
  try {
    // Keep paths: the log exists to diagnose the user's own files.
    const text = redactSecrets(message.slice(0, MAX_LINE)).replace(/\r?\n/g, '\n    ');
    const line = `${new Date().toISOString()} [${level}] ${text}\n`;
    if (written + line.length > MAX_BYTES) rotate(logFile);
    appendFileSync(logFile, line);
    written += Buffer.byteLength(line);
  } catch {
    // disk full or permissions: keep running without the log
  }
}

/** Start logging into `dir`; console output keeps going to stdout/stderr too. */
export function installAppLog(dir: string): string {
  mkdirSync(dir, { recursive: true });
  logFile = join(dir, 'app.log');
  try {
    written = existsSync(logFile) ? statSync(logFile).size : 0;
  } catch {
    written = 0;
  }
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      writeAppLog(level === 'log' ? 'info' : level, format(...args));
    };
  }
  // Monitor only: it records the crash without changing how Node handles it.
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    writeAppLog('fatal', `${origin}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  });
  writeAppLog('info', `--- OpenChatCut started (pid ${process.pid}, ${process.platform} ${process.arch}) ---`);
  return logFile;
}

const RENDERER_LEVELS: Record<string, string> = { debug: 'debug', info: 'info', warning: 'warn', error: 'error' };

/** Record a window's console output, load failures and crashes. */
export function attachRendererLog(contents: WebContents, name: string): void {
  contents.on('console-message', (event) => {
    const details = event as unknown as { level?: unknown; message?: unknown; sourceId?: unknown; lineNumber?: unknown };
    const level = RENDERER_LEVELS[String(details.level)] ?? 'info';
    const where = details.sourceId ? ` (${String(details.sourceId).replace(/^.*\//, '')}:${String(details.lineNumber ?? '?')})` : '';
    writeAppLog(level, `[renderer:${name}] ${String(details.message ?? '')}${where}`);
  });
  contents.on('render-process-gone', (_event, details) => {
    writeAppLog('error', `[renderer:${name}] process gone: ${details.reason} (exit ${details.exitCode})`);
  });
  contents.on('preload-error', (_event, preloadPath, error) => {
    writeAppLog('error', `[renderer:${name}] preload ${preloadPath} failed: ${error.stack ?? error.message}`);
  });
  contents.on('did-fail-load', (_event, code, description, url) => {
    writeAppLog('error', `[renderer:${name}] failed to load ${url}: ${description} (${code})`);
  });
}
