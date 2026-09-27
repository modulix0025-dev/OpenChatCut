import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

const require = createRequire(import.meta.url);
const ffmpegStatic = require('ffmpeg-static') as string | null;
const ffprobeInstaller = require('@ffprobe-installer/ffprobe') as { path?: string };

const ASAR_SEGMENT = `${sep}app.asar${sep}`;
const UNPACKED_SEGMENT = `${sep}app.asar.unpacked${sep}`;

/**
 * The on-disk twin of a path inside the packaged app archive.
 *
 * Electron's fs shim reads files inside app.asar transparently, but nothing can be
 * executed or dlopen'ed from there: spawn needs a real file. electron-builder keeps the
 * modules listed in asarUnpack as real files under app.asar.unpacked with the same
 * layout, so a resolved path is rewritten to that twin when it exists. Dev builds and
 * paths outside the archive come back unchanged.
 */
export function unpackedPath(path: string): string {
  const index = path.indexOf(ASAR_SEGMENT);
  if (index < 0) return path;
  const twin = `${path.slice(0, index)}${UNPACKED_SEGMENT}${path.slice(index + ASAR_SEGMENT.length)}`;
  return existsSync(twin) ? twin : path;
}

/**
 * Prefer explicit overrides for developers who need a custom FFmpeg build.
 * Packaged desktop builds fall back to the platform binaries shipped through
 * production dependencies, so media import does not depend on the user's PATH.
 */
export const PACKAGED_RUNTIME_ENV = 'OPENCHATCUT_PACKAGED';

/**
 * Executable allowlisting: a packaged desktop build runs only the binaries it
 * ships. Environment overrides (FFMPEG_PATH is set machine-wide by plenty of
 * other software) are a developer affordance and are ignored when packaged.
 */
export function binaryOverridesAllowed(): boolean {
  return process.env[PACKAGED_RUNTIME_ENV] !== '1';
}

function envOverride(...names: string[]): string | undefined {
  if (!binaryOverridesAllowed()) return undefined;
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
}

/**
 * The shipped binary, located from its package directory. ffmpeg-static and
 * @ffprobe-installer themselves honor FFMPEG_BIN / npm_config_platform at run
 * time, which would let the environment pick the executable; packaged builds
 * resolve the file directly instead.
 */
function shippedBinary(packageName: string, executable: string): string | null {
  try {
    const path = unpackedPath(join(dirname(require.resolve(`${packageName}/package.json`)), executable));
    return existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

const EXE = process.platform === 'win32' ? '.exe' : '';

export function ffmpegBin(): string {
  if (!binaryOverridesAllowed()) return shippedBinary('ffmpeg-static', `ffmpeg${EXE}`) ?? 'ffmpeg';
  return envOverride('OPENCHATCUT_FFMPEG', 'FFMPEG_PATH')
    ?? (ffmpegStatic ? unpackedPath(ffmpegStatic) : null)
    ?? 'ffmpeg';
}

export function ffprobeBin(): string {
  if (!binaryOverridesAllowed()) {
    return shippedBinary(`@ffprobe-installer/${process.platform}-${process.arch}`, `ffprobe${EXE}`) ?? 'ffprobe';
  }
  return envOverride('OPENCHATCUT_FFPROBE', 'FFPROBE_PATH')
    ?? (ffprobeInstaller.path ? unpackedPath(ffprobeInstaller.path) : null)
    ?? 'ffprobe';
}

/**
 * whisper.cpp CLI used by the desktop native-ASR worker (Metal/CPU). Dev and
 * packaged builds resolve from public/whisper-cli/<platform>/ (provisioned by
 * scripts/sync-whisper-cli.mjs and shipped through extraResources); an
 * explicit override wins for locally compiled binaries.
 */
export function whisperCliBin(): string {
  const override = envOverride('OPENCHATCUT_WHISPER_CLI');
  if (override) return override;
  const platformKey = `${process.platform}-${process.arch}`;
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const relative = join('whisper-cli', platformKey, `whisper-cli${suffix}`);
  const candidates = [
    join(import.meta.dirname, '..', 'public', relative),
    join(process.resourcesPath ?? '', 'dist', relative),
    join(process.resourcesPath ?? '', relative),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return join(candidates[0]!);
}
