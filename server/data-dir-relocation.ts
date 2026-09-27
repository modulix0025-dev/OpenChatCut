// Storage-root moves applied at startup, not while the app is running.
//
// A move used to copy the projects the moment the setting was saved. The app
// kept writing to the old root until it quit, and the next launch opened the
// copy, so every edit made in between was missing ("the project disappeared").
// A move is now recorded as pending and performed by the next launch before
// anything opens the project store (desktop/apply-pending-relocation.ts is
// the first import of desktop/main.ts). Until then the old root stays the
// effective root for every process. A folder that already holds projects is
// never overwritten or skipped silently: the user picks "replace" (the old
// data is kept as a backup) or "use existing".
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { dataDirPointerPath, RELOCATED_ENTRIES } from './data-dir.ts';

export type ExistingDataChoice = 'replace' | 'use-existing';

export interface PendingRelocation {
  readonly version: 1;
  readonly fromRoot: string;
  readonly toRoot: string;
  /** Pointer value once applied: the chosen path, or null for the default root. */
  readonly targetPointer: string | null;
  readonly fromMedia: string;
  readonly toMedia: string;
  readonly existing: 'none' | ExistingDataChoice;
  readonly requestedAt: string;
}

export interface RelocationReport {
  readonly ok: boolean;
  readonly at: string;
  readonly fromRoot: string;
  readonly toRoot: string;
  readonly copiedEntries?: number;
  readonly backups?: readonly string[];
  readonly error?: string;
}

const pendingPath = (home: string): string => join(home, '.openchatcut', 'pending-relocation.json');
const reportPath = (home: string): string => join(home, '.openchatcut', 'last-relocation.json');

export function readPendingRelocation(home: string = homedir()): PendingRelocation | null {
  try {
    const parsed = JSON.parse(readFileSync(pendingPath(home), 'utf8')) as Partial<PendingRelocation>;
    if (parsed?.version !== 1 || typeof parsed.fromRoot !== 'string' || typeof parsed.toRoot !== 'string') return null;
    return parsed as PendingRelocation;
  } catch {
    return null;
  }
}

export function writePendingRelocation(pending: PendingRelocation, home: string = homedir()): void {
  mkdirSync(join(home, '.openchatcut'), { recursive: true });
  writeFileSync(pendingPath(home), `${JSON.stringify(pending, null, 2)}\n`, { mode: 0o600 });
}

export function clearPendingRelocation(home: string = homedir()): void {
  rmSync(pendingPath(home), { force: true });
}

export function readRelocationReport(home: string = homedir()): RelocationReport | null {
  try {
    return JSON.parse(readFileSync(reportPath(home), 'utf8')) as RelocationReport;
  } catch {
    return null;
  }
}

function writeReport(report: RelocationReport, home: string): void {
  mkdirSync(join(home, '.openchatcut'), { recursive: true });
  writeFileSync(reportPath(home), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

function newestMtime(path: string): number {
  const info = statSync(path);
  if (!info.isDirectory()) return info.mtimeMs;
  let newest = info.mtimeMs;
  for (const name of readdirSync(path)) newest = Math.max(newest, newestMtime(join(path, name)));
  return newest;
}

const nonEmpty = (path: string): boolean => {
  if (!existsSync(path)) return false;
  const info = statSync(path);
  return info.isDirectory() ? readdirSync(path).length > 0 : info.size > 0;
};

/** OpenChatCut project data already present in `dir`, with its newest change. */
export function projectDataIn(dir: string): { entries: string[]; newestMtimeMs: number | null } {
  const entries = RELOCATED_ENTRIES.filter((entry) => nonEmpty(join(dir, entry)));
  const newestMtimeMs = entries.length
    ? Math.max(...entries.map((entry) => newestMtime(join(dir, entry))))
    : null;
  return { entries, newestMtimeMs };
}

/** Folders a sync client may rewrite, lock or keep online-only. */
export function isCloudSyncedPath(path: string): boolean {
  return /(^|[\\/])(OneDrive(\s+-\s+[^\\/]+)?|Dropbox|iCloud\s?Drive|iCloudDrive|Google\s?Drive|Mobile Documents)([\\/]|$)/i.test(path);
}

/** Copy files from `from` that `to` lacks; never overwrites. */
function copyMissingSync(from: string, to: string): number {
  if (!existsSync(from)) return 0;
  let copied = 0;
  for (const name of readdirSync(from)) {
    const source = join(from, name);
    const destination = join(to, name);
    if (statSync(source).isDirectory()) {
      copied += copyMissingSync(source, destination);
    } else if (!existsSync(destination)) {
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(source, destination);
      copied += 1;
    }
  }
  return copied;
}

function writePointerSync(dir: string | null, home: string): void {
  const pointer = dataDirPointerPath(home);
  mkdirSync(dirname(pointer), { recursive: true });
  if (!dir) {
    rmSync(pointer, { force: true });
    return;
  }
  const staging = `${pointer}.incoming`;
  writeFileSync(staging, `${JSON.stringify({ version: 1, dataDir: dir }, null, 2)}\n`, { mode: 0o600 });
  renameSync(staging, pointer);
}

/**
 * Perform a pending move. Called once at startup, before the project store
 * opens. On failure the pointer is left alone, so the app keeps using the old
 * root with all its data, and the reason is recorded for the settings page.
 */
export function applyPendingRelocationSync(
  home: string = homedir(),
  log: (message: string) => void = (message) => console.log(message),
): RelocationReport | null {
  const pending = readPendingRelocation(home);
  if (!pending) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backups: string[] = [];
  let copiedEntries = 0;
  const staged: string[] = [];
  try {
    if (pending.fromRoot !== pending.toRoot && pending.existing !== 'use-existing') {
      mkdirSync(pending.toRoot, { recursive: true });
      for (const entry of RELOCATED_ENTRIES) {
        const from = join(pending.fromRoot, entry);
        if (!existsSync(from)) continue;
        const to = join(pending.toRoot, entry);
        if (nonEmpty(to)) {
          if (pending.existing !== 'replace') {
            throw new Error(`${to} already contains project data; choose "replace" or "use existing" in settings`);
          }
          const backup = `${to}.before-move-${stamp}`;
          renameSync(to, backup);
          backups.push(relative(pending.toRoot, backup));
        } else {
          rmSync(to, { recursive: true, force: true });
        }
        // Whole entry or nothing: copy aside, then rename into place.
        const staging = `${to}.incoming`;
        rmSync(staging, { recursive: true, force: true });
        staged.push(staging);
        cpSync(from, staging, { recursive: true });
        renameSync(staging, to);
        copiedEntries += 1;
      }
      // Media was bulk-copied when the move was requested; bring over what
      // arrived since then.
      if (pending.fromMedia !== pending.toMedia) {
        const late = copyMissingSync(pending.fromMedia, pending.toMedia);
        if (late) log(`[data-dir] copied ${late} media files added since the move was requested`);
      }
    }
    writePointerSync(pending.targetPointer, home);
    clearPendingRelocation(home);
    const report: RelocationReport = {
      ok: true, at: new Date().toISOString(), fromRoot: pending.fromRoot, toRoot: pending.toRoot,
      copiedEntries, ...(backups.length ? { backups } : {}),
    };
    writeReport(report, home);
    log(`[data-dir] storage moved at startup: ${pending.fromRoot} → ${pending.toRoot} (${copiedEntries} entries)`);
    return report;
  } catch (error) {
    for (const staging of staged) rmSync(staging, { recursive: true, force: true });
    clearPendingRelocation(home);
    const report: RelocationReport = {
      ok: false, at: new Date().toISOString(), fromRoot: pending.fromRoot, toRoot: pending.toRoot,
      error: error instanceof Error ? error.message : String(error),
    };
    writeReport(report, home);
    log(`[data-dir] storage move failed; still using ${pending.fromRoot}: ${report.error}`);
    return report;
  }
}
