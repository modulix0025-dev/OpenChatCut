// Storage-root moves happen at the next launch, with the latest data.
// Reproduces the lost-edits report: the folder was changed, work continued,
// and the next launch opened a copy taken before that work.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDataDirPointer } from './data-dir.ts';
import {
  applyPendingRelocationSync,
  isCloudSyncedPath,
  projectDataIn,
  readPendingRelocation,
  readRelocationReport,
  writePendingRelocation,
  type PendingRelocation,
} from './data-dir-relocation.ts';

const fixture = await mkdtemp(join(tmpdir(), 'openchatcut-relocation-'));
const quiet = () => undefined;
try {
  const home = join(fixture, 'home');
  const oldRoot = join(home, '.openchatcut');
  const oldMedia = join(fixture, 'uploads');
  const project = (root: string) => join(root, 'project-store-v1', 'p1.json');
  await mkdir(join(oldRoot, 'project-store-v1'), { recursive: true });
  await mkdir(oldMedia, { recursive: true });
  await writeFile(project(oldRoot), JSON.stringify({ scenes: 1 }));
  await writeFile(join(oldMedia, 'a.mp4'), 'a');

  const newRoot = join(fixture, 'OneDrive', 'Desktop');
  const newMedia = join(newRoot, 'media', 'uploads');
  const pending = (overrides: Partial<PendingRelocation> = {}): PendingRelocation => ({
    version: 1, fromRoot: oldRoot, toRoot: newRoot, targetPointer: newRoot,
    fromMedia: oldMedia, toMedia: newMedia, existing: 'none', requestedAt: new Date().toISOString(), ...overrides,
  });

  // 1. Saving the setting only schedules the move: the old root stays in use.
  writePendingRelocation(pending(), home);
  assert.equal(readDataDirPointer(home), null, 'until the restart every process keeps the old root');
  assert.equal(existsSync(project(newRoot)), false, 'nothing is copied at save time');

  // 2. Work continues after saving (the edits the old code lost).
  await writeFile(project(oldRoot), JSON.stringify({ scenes: 7 }));
  await writeFile(join(oldMedia, 'late.mp4'), 'late');

  // 3. Next launch: the move runs before the store opens, with the latest data.
  const report = applyPendingRelocationSync(home, quiet);
  assert.equal(report?.ok, true);
  assert.deepEqual(JSON.parse(await readFile(project(newRoot), 'utf8')), { scenes: 7 }, 'edits made after saving arrive');
  assert.equal(await readFile(join(newMedia, 'late.mp4'), 'utf8'), 'late', 'media added after saving arrives');
  assert.equal(readDataDirPointer(home), newRoot);
  assert.equal(readPendingRelocation(home), null);
  assert.equal(readRelocationReport(home)?.ok, true);
  assert.deepEqual(JSON.parse(await readFile(project(oldRoot), 'utf8')), { scenes: 7 }, 'the source is left untouched');
  assert.equal(applyPendingRelocationSync(home, quiet), null, 'nothing pending: startup does nothing');

  // 4. Destination already has (older) projects: detected, never silently skipped.
  const data = projectDataIn(newRoot);
  assert.deepEqual(data.entries, ['project-store-v1']);
  assert.ok(data.newestMtimeMs && data.newestMtimeMs > 0);
  const other = join(fixture, 'other');
  await mkdir(join(other, 'project-store-v1'), { recursive: true });
  await writeFile(project(other), JSON.stringify({ scenes: 2, stale: true }));
  writePendingRelocation(pending({ fromRoot: newRoot, toRoot: other, targetPointer: other, fromMedia: newMedia, toMedia: join(other, 'media', 'uploads') }), home);
  const refused = applyPendingRelocationSync(home, quiet);
  assert.equal(refused?.ok, false, 'no choice recorded: the move fails loudly');
  assert.match(refused?.error ?? '', /already contains project data/);
  assert.equal(readDataDirPointer(home), newRoot, 'a failed move keeps the app on its current data');
  assert.deepEqual(JSON.parse(await readFile(project(other), 'utf8')), { scenes: 2, stale: true }, 'and touches nothing there');

  // 5. "Replace": current projects move in, the old ones are kept as a backup.
  writePendingRelocation(pending({ fromRoot: newRoot, toRoot: other, targetPointer: other, fromMedia: newMedia, toMedia: join(other, 'media', 'uploads'), existing: 'replace' }), home);
  const replaced = applyPendingRelocationSync(home, quiet);
  assert.equal(replaced?.ok, true);
  assert.deepEqual(JSON.parse(await readFile(project(other), 'utf8')), { scenes: 7 });
  const backup = (await readdir(other)).find((name) => name.startsWith('project-store-v1.before-move-'));
  assert.ok(backup, 'the replaced data is kept');
  assert.deepEqual(JSON.parse(await readFile(join(other, backup, 'p1.json'), 'utf8')), { scenes: 2, stale: true });

  // 6. "Use existing": switch folders without copying anything.
  const third = join(fixture, 'third');
  await mkdir(join(third, 'project-store-v1'), { recursive: true });
  await writeFile(project(third), JSON.stringify({ scenes: 3 }));
  writePendingRelocation(pending({ fromRoot: other, toRoot: third, targetPointer: third, existing: 'use-existing' }), home);
  assert.equal(applyPendingRelocationSync(home, quiet)?.ok, true);
  assert.deepEqual(JSON.parse(await readFile(project(third), 'utf8')), { scenes: 3 });
  assert.equal(readDataDirPointer(home), third);

  // 7. Back to the default root (pointer cleared).
  writePendingRelocation(pending({ fromRoot: third, toRoot: join(fixture, 'fresh-default'), targetPointer: null, fromMedia: oldMedia, toMedia: oldMedia }), home);
  assert.equal(applyPendingRelocationSync(home, quiet)?.ok, true);
  assert.equal(readDataDirPointer(home), null);

  // 8. Cloud-synced folders are recognized for the warning.
  for (const path of ['C:\\Users\\Myfam\\OneDrive\\Desktop', 'C:\\Users\\a\\OneDrive - Contoso\\x', '/Users/a/Dropbox/cc', '/Users/a/Library/Mobile Documents/com~apple~CloudDocs', 'D:\\Google Drive\\p']) {
    assert.ok(isCloudSyncedPath(path), path);
  }
  for (const path of ['C:\\Users\\Myfam\\Videos\\OpenChatCut', '/home/a/projects/onedrive-notes']) {
    assert.ok(!isCloudSyncedPath(path), path);
  }
} finally {
  await rm(fixture, { recursive: true, force: true });
}
console.log('data-dir-relocation.verify: moves apply at startup with the latest data; existing data needs a choice');
