// Preparation for runtime in packaged state: Resources is a read-only area, and the two things needed for rendering must be pointed to available locations —
// ① remotion serve bundle:uploads symlink to be written into the bundle directory → copy to according to version
// userData (first startup, the old version directory will be cleared easily);
// ② chrome-headless-shell: distributed with the package, find the executable file path to render.mjs.
// Both are passed through environment variables (CC_REMOTION_BUNDLE / CC_BROWSER_EXECUTABLE), dev does not set the old behavior.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { cp, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureRemotionBinaries } from './remotion-binaries.ts';

/** Find the chrome-headless-shell executable file in the distribution directory (the level varies with the platform, small-scale recursion). */
export function findBundledBrowser(root: string, depth = 4): string | null {
  if (depth < 0 || !existsSync(root)) return null;
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    const st = statSync(p);
    if (st.isFile() && (name === 'chrome-headless-shell' || name === 'chrome-headless-shell.exe')) return p;
    if (st.isDirectory()) {
      const hit = findBundledBrowser(p, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

export interface PackagedPaths {
  resourcesPath: string;
  userDataPath: string;
  version: string;
}

const BUNDLE_MARKER = '.openchatcut-bundle.json';

/** Every file of a bundle with its size, relative paths in a stable order. */
export function bundleManifest(root: string): Array<[string, number]> {
  const entries: Array<[string, number]> = [];
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name === BUNDLE_MARKER) continue;
      const path = join(dir, name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) continue; // the uploads link is created at run time
      if (info.isDirectory()) walk(path, `${prefix}${name}/`);
      else if (info.isFile()) entries.push([`${prefix}${name}`, info.size]);
    }
  };
  walk(root, '');
  return entries;
}

const fingerprintOf = (manifest: Array<[string, number]>): string =>
  createHash('sha256').update(JSON.stringify(manifest)).digest('hex');

/** True when `dst` holds a complete copy of the bundle described by `manifest`. */
export function bundleIntact(dst: string, manifest: Array<[string, number]>): boolean {
  try {
    const marker = JSON.parse(readFileSync(join(dst, BUNDLE_MARKER), 'utf8')) as { fingerprint?: unknown };
    if (marker.fingerprint !== fingerprintOf(manifest)) return false;
    return manifest.every(([path, size]) => {
      try {
        return statSync(join(dst, path)).size === size;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/** Delete a bundle copy. Its media/uploads is a link (a junction on Windows)
 *  to the user's real media folder: unlink it first, so removing the bundle
 *  can never reach the media behind it. */
async function removeBundle(dir: string): Promise<void> {
  const uploads = join(dir, 'media', 'uploads');
  try {
    if (lstatSync(uploads).isSymbolicLink()) await unlink(uploads);
  } catch {
    // no link there
  }
  await rm(dir, { recursive: true, force: true });
}

/** Copy the serve bundle into userData (with version number, clean up old
 *  versions) and return the writable bundle path. The copy is checked against
 *  the shipped bundle on every launch (file list and sizes) and redone when
 *  it is incomplete or damaged; it used to be rebuilt only when index.html
 *  was missing, so a copy interrupted after that file stayed broken. */
export async function ensureWritableBundle({ resourcesPath, userDataPath, version }: PackagedPaths): Promise<string> {
  const src = join(resourcesPath, 'remotion-bundle');
  const dst = join(userDataPath, `remotion-bundle-${version}`);
  for (const name of readdirSync(userDataPath)) {
    if (name.startsWith('remotion-bundle-') && name !== `remotion-bundle-${version}`) {
      await removeBundle(join(userDataPath, name));
    }
  }
  const manifest = bundleManifest(src);
  if (!bundleIntact(dst, manifest)) {
    if (existsSync(dst)) console.warn(`[desktop] render bundle at ${dst} is incomplete or damaged; recreating it`);
    // Copy aside, mark complete, then swap in: an interrupted copy never looks finished.
    const staging = `${dst}.incoming`;
    await rm(staging, { recursive: true, force: true });
    await cp(src, staging, { recursive: true });
    await writeFile(join(staging, BUNDLE_MARKER), JSON.stringify({ version, fingerprint: fingerprintOf(manifest) }));
    await removeBundle(dst);
    await rename(staging, dst);
  }
  return dst;
}

/** Configure packaged render assets before the first rendering request. */
export async function preparePackagedRuntime(paths: PackagedPaths): Promise<void> {
  process.env.CC_REMOTION_BUNDLE = await ensureWritableBundle(paths);
  // Packaged builds only execute the render binaries they ship: inherited
  // CC_BROWSER_EXECUTABLE / CC_REMOTION_BINARIES_DIR values are discarded.
  const browser = findBundledBrowser(join(paths.resourcesPath, 'chrome-headless-shell'));
  if (browser) process.env.CC_BROWSER_EXECUTABLE = browser;
  else delete process.env.CC_BROWSER_EXECUTABLE;
  // A real, writable copy of the compositor: the archive cannot be chmod'ed or spawned.
  process.env.CC_REMOTION_BINARIES_DIR = await ensureRemotionBinaries({
    userDataPath: paths.userDataPath,
    version: paths.version,
  });
}
