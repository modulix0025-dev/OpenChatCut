// Stage the two platform-specific binaries required for a cross-platform package:
//   1. chrome-headless-shell for rendering/export into desktop-dist/chrome-headless-shell.
//      config/electron-builder.config.mjs always reads extraResources from this staging directory.
//   2. @remotion/compositor-<target>. npm installs only the host package, so cross-builds add it manually.
//   3. Cross-builds for win32-x64 from a non-Windows host (Linux CI/cloud): the
//      Windows variants of every native production dependency (lockfile-pinned
//      versions, integrity-checked npm tarballs), the Windows FFmpeg binary,
//      and the SHA-256-pinned whisper.cpp Windows release.
// Usage: npx tsx desktop/prepare-target.mts darwin-arm64|darwin-x64|win32-x64|linux-x64
// Chrome comes from the Chrome for Testing CDN used by @remotion/renderer at the same version.
// The compositor uses npm pack and respects .npmrc registry settings. Both downloads are cached.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { chmod, cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const STAGING = join(ROOT, 'desktop-dist', 'chrome-headless-shell');
const CACHE = join(ROOT, 'node_modules', '.remotion', 'chrome-headless-shell');
const FALLBACK_CHROME_VERSION = '149.0.7790.0'; // renderer TESTED_VERSION fallback when the cached VERSION file is missing

interface Target {
  /** Chrome for Testing platform name used in download URLs and directory names. */
  cft: string;
  /** Platform package name for @remotion/compositor. */
  compositor: string;
  /** Chrome executable name. */
  bin: string;
}

// Compositor names follow @remotion/renderer optionalDependencies; win32 packages use the -msvc suffix.
const TARGETS: Record<string, Target> = {
  'darwin-arm64': { cft: 'mac-arm64', compositor: '@remotion/compositor-darwin-arm64', bin: 'chrome-headless-shell' },
  'darwin-x64': { cft: 'mac-x64', compositor: '@remotion/compositor-darwin-x64', bin: 'chrome-headless-shell' },
  'win32-x64': { cft: 'win64', compositor: '@remotion/compositor-win32-x64-msvc', bin: 'chrome-headless-shell.exe' },
  // Chrome for Testing ships linux64 only, so desktop Linux supports x64 only.
  // AppImage targets glibc distributions, so use the -gnu compositor variant.
  'linux-x64': { cft: 'linux64', compositor: '@remotion/compositor-linux-x64-gnu', bin: 'chrome-headless-shell' },
};

async function chromeVersion(): Promise<string> {
  const v = await readFile(join(CACHE, 'VERSION'), 'utf8').catch(() => '');
  return v.trim() || FALLBACK_CHROME_VERSION;
}

async function download(url: string, dest: string): Promise<void> {
  console.log(`[prepare] downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} ${url}`);
  await mkdir(dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(dest));
}

/** Ensure chrome-headless-shell is cached for the target platform, downloading and extracting it if needed. */
async function ensureChrome(t: Target): Promise<string> {
  const dir = join(CACHE, t.cft);
  const marker = join(dir, `chrome-headless-shell-${t.cft}`, t.bin);
  if (existsSync(marker)) return dir;
  const ver = await chromeVersion();
  const zip = join(ROOT, 'desktop-dist', `chs-${t.cft}-${ver}.zip`);
  if (!existsSync(zip)) {
    await download(`https://storage.googleapis.com/chrome-for-testing-public/${ver}/${t.cft}/chrome-headless-shell-${t.cft}.zip`, zip);
  }
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  // bsdtar (macOS/Windows) reads zip; GNU tar on Linux does not.
  if (process.platform === 'linux') execFileSync('unzip', ['-q', zip, '-d', dir]);
  else execFileSync('tar', ['-xf', zip, '-C', dir]);
  if (!existsSync(marker)) throw new Error(`unzip produced no ${marker}`);
  if (t.bin === 'chrome-headless-shell') await chmod(marker, 0o755);
  return dir;
}

/** Install the target compositor package with npm pack and tgz extraction, bypassing host OS/CPU filters. */
async function ensureCompositor(pkg: string): Promise<void> {
  const dest = join(ROOT, 'node_modules', ...pkg.split('/'));
  if (existsSync(join(dest, 'package.json'))) {
    console.log(`[prepare] compositor ok: ${pkg}`);
    return;
  }
  const rendererVer = JSON.parse(await readFile(join(ROOT, 'node_modules/@remotion/renderer/package.json'), 'utf8')).version as string;
  const tmp = join(ROOT, 'desktop-dist', 'pack-tmp');
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  console.log(`[prepare] npm pack ${pkg}@${rendererVer}`);
  execFileSync('npm', ['pack', `${pkg}@${rendererVer}`, '--pack-destination', tmp], { stdio: 'inherit' });
  const tgz = (await readdir(tmp)).find((n) => n.endsWith('.tgz'));
  if (!tgz) throw new Error(`npm pack produced no tgz for ${pkg}`);
  execFileSync('tar', ['-xzf', join(tmp, tgz), '-C', tmp]);
  await mkdir(join(dest, '..'), { recursive: true });
  await rm(dest, { recursive: true, force: true });
  await rename(join(tmp, 'package'), dest);
  await rm(tmp, { recursive: true, force: true });
  console.log(`[prepare] compositor installed: ${pkg}@${rendererVer}`);
}

// Windows builds of the native production dependencies. npm only installs the
// host's optional platform packages, so a Linux host must add these itself.
const WIN32_X64_PLATFORM_PACKAGES = [
  '@ffprobe-installer/win32-x64',
  'sqlite-vec-windows-x64',
  '@img/sharp-win32-x64',
  '@koromix/koffi-win32-x64',
  '@napi-rs/canvas-win32-x64-msvc',
  '@github/copilot-win32-x64',
  // Loaded at startup through @remotion/bundler → @rspack/core, even though the
  // packaged app renders from the prebuilt bundle.
  '@rspack/binding-win32-x64-msvc',
  '@esbuild/win32-x64',
];

interface LockEntry { version?: string; integrity?: string; resolved?: string }

async function lockEntry(pkg: string): Promise<LockEntry> {
  const lock = JSON.parse(await readFile(join(ROOT, 'package-lock.json'), 'utf8')) as { packages: Record<string, LockEntry> };
  const entry = lock.packages[`node_modules/${pkg}`];
  if (!entry?.version || !entry.integrity) throw new Error(`${pkg} is not pinned in package-lock.json`);
  return entry;
}

/** npm pack a lockfile-pinned package and verify the tarball against the lockfile integrity. */
async function ensurePinnedPackage(pkg: string): Promise<void> {
  const dest = join(ROOT, 'node_modules', ...pkg.split('/'));
  const entry = await lockEntry(pkg);
  if (existsSync(join(dest, 'package.json'))) {
    const installed = JSON.parse(await readFile(join(dest, 'package.json'), 'utf8')) as { version?: string };
    if (installed.version === entry.version) {
      console.log(`[prepare] ${pkg}@${entry.version} ok`);
      return;
    }
  }
  const tmp = join(ROOT, 'desktop-dist', 'pack-tmp');
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  execFileSync('npm', ['pack', `${pkg}@${entry.version}`, '--pack-destination', tmp], { stdio: 'inherit' });
  const tgz = (await readdir(tmp)).find((n) => n.endsWith('.tgz'));
  if (!tgz) throw new Error(`npm pack produced no tgz for ${pkg}`);
  const [algorithm, expected] = entry.integrity!.split('-', 2) as [string, string];
  const actual = createHash(algorithm).update(await readFile(join(tmp, tgz))).digest('base64');
  if (actual !== expected) throw new Error(`${pkg}@${entry.version}: tarball does not match package-lock.json integrity`);
  execFileSync('tar', ['-xzf', join(tmp, tgz), '-C', tmp]);
  await mkdir(dirname(dest), { recursive: true });
  await rm(dest, { recursive: true, force: true });
  await rename(join(tmp, 'package'), dest);
  await rm(tmp, { recursive: true, force: true });
  console.log(`[prepare] ${pkg}@${entry.version} installed (integrity verified)`);
}

/** Replace the host FFmpeg in ffmpeg-static with its Windows build. */
async function ensureWindowsFfmpeg(): Promise<void> {
  const dir = join(ROOT, 'node_modules', 'ffmpeg-static');
  const exe = join(dir, 'ffmpeg.exe');
  if (!existsSync(exe)) {
    execFileSync(process.execPath, [join(dir, 'install.js')], {
      cwd: dir,
      stdio: 'inherit',
      env: { ...process.env, npm_config_platform: 'win32', npm_config_arch: 'x64' },
    });
  }
  if (!existsSync(exe)) throw new Error('ffmpeg-static did not produce ffmpeg.exe');
  // The host binary must not ship inside a Windows package.
  await rm(join(dir, 'ffmpeg'), { force: true });
  const digest = createHash('sha256').update(await readFile(exe)).digest('hex');
  console.log(`[prepare] ffmpeg-static win32-x64 ffmpeg.exe sha256=${digest}`);
}

/** Stage the pinned whisper.cpp Windows release under public/whisper-cli/win32-x64. */
async function ensureWindowsWhisper(): Promise<void> {
  const { PLATFORMS, VERSION, archiveProblem, flattenExecutableDir, PROVENANCE_SUFFIX } = await import(new URL('../scripts/sync-whisper-cli.mjs', import.meta.url).href) as {
    PLATFORMS: Record<string, { asset: string | null; archiveBytes?: number; archiveSha256?: string; executable: string }>;
    VERSION: string;
    archiveProblem: (bytes: Uint8Array, spec: unknown) => string | null;
    flattenExecutableDir: (dir: string, executable: string) => Promise<string>;
    PROVENANCE_SUFFIX: string;
  };
  const spec = PLATFORMS['win32-x64']!;
  const targetDir = join(ROOT, 'public', 'whisper-cli', 'win32-x64');
  const binPath = join(targetDir, spec.executable);
  if (existsSync(binPath) && existsSync(binPath + PROVENANCE_SUFFIX)) {
    console.log('[prepare] whisper-cli win32-x64 ok');
    return;
  }
  const url = `https://github.com/ggml-org/whisper.cpp/releases/download/${VERSION}/${spec.asset}`;
  console.log(`[prepare] downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed ${response.status} for ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const problem = archiveProblem(bytes, spec);
  if (problem) throw new Error(`whisper-cli win32-x64: ${problem}`);
  const zip = join(ROOT, 'desktop-dist', 'whisper-win32-x64.zip');
  await mkdir(dirname(zip), { recursive: true });
  await writeFile(zip, bytes);
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });
  execFileSync('unzip', ['-q', zip, '-d', targetDir]);
  const bin = await flattenExecutableDir(targetDir, spec.executable);
  const binary = await readFile(bin);
  await writeFile(bin + PROVENANCE_SUFFIX, `${JSON.stringify({
    version: VERSION,
    platform: 'win32-x64',
    source: 'asset',
    asset: spec.asset,
    archiveSha256: spec.archiveSha256,
    binaryBytes: binary.length,
    binarySha256: createHash('sha256').update(binary).digest('hex'),
    recordedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  await rm(zip, { force: true });
  console.log(`[prepare] whisper-cli win32-x64 staged (archive sha256 verified)`);
}

async function main(): Promise<void> {
  const key = process.argv[2] ?? `${process.platform}-${process.arch}`;
  const t = TARGETS[key];
  if (!t) throw new Error(`unknown target "${key}" — use one of: ${Object.keys(TARGETS).join(' / ')}`);

  const chromeDir = await ensureChrome(t);
  await rm(STAGING, { recursive: true, force: true });
  await mkdir(STAGING, { recursive: true });
  await cp(chromeDir, join(STAGING, t.cft), { recursive: true });
  await ensureCompositor(t.compositor);
  if (key === 'win32-x64' && process.platform !== 'win32') {
    for (const pkg of WIN32_X64_PLATFORM_PACKAGES) await ensurePinnedPackage(pkg);
    await ensureWindowsFfmpeg();
    await ensureWindowsWhisper();
  }
  console.log(`[prepare] ${key} ready — chrome staged at desktop-dist/chrome-headless-shell/${t.cft}`);
}

main().catch((err) => {
  console.error('[prepare] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
