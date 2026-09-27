// The packaged render bundle copy is verified on every launch and recreated
// when incomplete, and recreating it never touches the linked media folder.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleIntact, bundleManifest, ensureWritableBundle } from './packaged-runtime.ts';

const root = await mkdtemp(join(tmpdir(), 'openchatcut-bundle-'));
try {
  const resourcesPath = join(root, 'resources');
  const userDataPath = join(root, 'userData');
  const src = join(resourcesPath, 'remotion-bundle');
  await mkdir(join(src, 'media'), { recursive: true });
  await mkdir(userDataPath, { recursive: true });
  await writeFile(join(src, 'index.html'), '<html></html>');
  await writeFile(join(src, 'bundle.js'), 'x'.repeat(5000));
  await writeFile(join(src, 'media', 'sample.mp3'), 'mp3');
  const paths = { resourcesPath, userDataPath, version: '0.2.14' };

  const dst = await ensureWritableBundle(paths);
  assert.equal(dst, join(userDataPath, 'remotion-bundle-0.2.14'));
  assert.ok(bundleIntact(dst, bundleManifest(src)));

  // The runtime links media/uploads to the user's media folder.
  const userMedia = join(root, 'my-media');
  await mkdir(userMedia);
  await writeFile(join(userMedia, 'precious.mp4'), 'keep me');
  await symlink(userMedia, join(dst, 'media', 'uploads'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.ok(bundleIntact(dst, bundleManifest(src)), 'the runtime uploads link does not count as damage');

  // A copy cut short after index.html (the old check only looked at index.html).
  await truncate(join(dst, 'bundle.js'), 100);
  assert.equal(bundleIntact(dst, bundleManifest(src)), false);
  await ensureWritableBundle(paths);
  assert.equal((await readFile(join(dst, 'bundle.js'), 'utf8')).length, 5000, 'damaged bundle recreated');
  assert.equal(await readFile(join(userMedia, 'precious.mp4'), 'utf8'), 'keep me', "the user's media survives");

  // A missing file, and a copy without the completion marker.
  await unlink(join(dst, 'media', 'sample.mp3'));
  await ensureWritableBundle(paths);
  assert.ok(existsSync(join(dst, 'media', 'sample.mp3')));
  await unlink(join(dst, '.openchatcut-bundle.json'));
  assert.equal(bundleIntact(dst, bundleManifest(src)), false, 'no marker means not known complete');

  // A new app version gets a new copy and the old one goes, media intact.
  await symlink(userMedia, join(dst, 'media', 'uploads'), process.platform === 'win32' ? 'junction' : 'dir').catch(() => undefined);
  await ensureWritableBundle({ ...paths, version: '0.2.15' });
  assert.equal(existsSync(dst), false);
  assert.equal(await readFile(join(userMedia, 'precious.mp4'), 'utf8'), 'keep me');
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log('packaged-runtime.verify: bundle integrity checked each launch; media links never followed');
