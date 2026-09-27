// Path validation for local filesystem paths that arrive from untrusted callers:
// the renderer, the in-app agent, external MCP clients, project files, or
// imported metadata. Callers still perform their own containment checks
// (realpath + isPathInside against a granted root); this module rejects the
// path shapes that must never reach the filesystem at all.
//
// Windows-specific shapes are rejected on every platform, so a project or MCP
// payload authored for Windows cannot slip through when validated elsewhere.
import { isAbsolute, win32 } from 'node:path';

export type UnsafeLocalPathReason =
  | 'empty'
  | 'too-long'
  | 'control-character'
  | 'not-absolute'
  | 'unc-path'
  | 'device-path'
  | 'alternate-data-stream'
  | 'reserved-device-name'
  | 'trailing-dot-or-space'
  | 'url';

export class UnsafeLocalPathError extends Error {
  readonly reason: UnsafeLocalPathReason;
  constructor(reason: UnsafeLocalPathReason) {
    super(`unsafe local path (${reason})`);
    this.name = 'UnsafeLocalPathError';
    this.reason = reason;
  }
}

const MAX_PATH_LENGTH = 4096;

/** C0 controls and DEL: never legitimate in a path, and NUL truncates in native code. */
export function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
// CON, PRN, AUX, NUL, COM0-9, LPT0-9 (plus the superscript-digit variants
// Windows also treats as devices), with or without an extension.
const RESERVED_WINDOWS_NAME = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** Why `raw` is unsafe as a local path, or null when it is acceptable. */
export function unsafeLocalPathReason(raw: unknown, platform: NodeJS.Platform = process.platform): UnsafeLocalPathReason | null {
  if (typeof raw !== 'string' || raw.length === 0) return 'empty';
  if (raw.length > MAX_PATH_LENGTH) return 'too-long';
  // NUL truncates paths in native code; other controls are never legitimate.
  if (hasControlCharacter(raw)) return 'control-character';
  // \\server\share, //server/share, \\?\C:\…, \\.\PhysicalDrive0, \??\…
  if (/^[\\/]{2}[?.][\\/]/.test(raw) || raw.startsWith('\\??\\')) return 'device-path';
  if (/^[\\/]{2}/.test(raw)) return 'unc-path';
  if (/^[a-z][a-z0-9+.-]+:\/\//i.test(raw)) return 'url';

  const windowsShaped = platform === 'win32' || /^[a-z]:[\\/]/i.test(raw) || raw.includes('\\');
  if (windowsShaped) {
    if (!win32.isAbsolute(raw) || !/^[a-z]:[\\/]/i.test(raw)) {
      // Drive-relative (C:foo) and root-relative (\foo) paths depend on hidden
      // per-drive state; only fully qualified drive paths are accepted.
      return 'not-absolute';
    }
    // A colon anywhere after the drive letter selects an NTFS alternate stream.
    if (raw.slice(2).includes(':')) return 'alternate-data-stream';
    for (const segment of raw.slice(3).split(/[\\/]+/)) {
      if (!segment) continue;
      if (RESERVED_WINDOWS_NAME.test(segment)) return 'reserved-device-name';
      if (/[. ]$/.test(segment) && segment !== '.' && segment !== '..') return 'trailing-dot-or-space';
    }
    return null;
  }
  if (!isAbsolute(raw)) return 'not-absolute';
  return null;
}

/** Throws UnsafeLocalPathError unless `raw` is a plain absolute local path. */
export function assertSafeLocalPath(raw: unknown, platform: NodeJS.Platform = process.platform): string {
  const reason = unsafeLocalPathReason(raw, platform);
  if (reason) throw new UnsafeLocalPathError(reason);
  return raw as string;
}

export function isSafeLocalPath(raw: unknown, platform: NodeJS.Platform = process.platform): raw is string {
  return unsafeLocalPathReason(raw, platform) === null;
}

/** Validation for a single file or directory name (no separators at all). */
export function isSafeFileNameSegment(name: unknown): name is string {
  if (typeof name !== 'string' || !name || name.length > 255) return false;
  if (name === '.' || name === '..') return false;
  if (hasControlCharacter(name) || /[<>:"/\\|?*]/.test(name)) return false;
  if (RESERVED_WINDOWS_NAME.test(name)) return false;
  if (/[. ]$/.test(name)) return false;
  return true;
}
