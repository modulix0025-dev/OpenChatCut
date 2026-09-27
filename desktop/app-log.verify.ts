// The packaged app's persistent log: console output, failed media processes
// and redaction, with size-based rotation.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appLogPath, installAppLog, writeAppLog } from './app-log.ts';
import { spawnMediaProcess } from '../server/media-process.ts';

const require = createRequire(import.meta.url);
const ffprobe = (require('@ffprobe-installer/ffprobe') as { path: string }).path;
const dir = await mkdtemp(join(tmpdir(), 'openchatcut-app-log-'));
try {
  const file = installAppLog(dir);
  assert.equal(file, join(dir, 'app.log'));
  assert.equal(appLogPath(), file);
  console.error('[probe] import failed for LTX-2.5_i2v_00020_.mp4', { reason: 'no video stream' });
  console.log('api_key=sk-live-abcdefghijklmnopqrstuvwxyz0123456789 should not be stored');

  // A failed ffprobe run is logged with its arguments and stderr.
  await new Promise<void>((resolve) => {
    const child = spawnMediaProcess(ffprobe, ['-v', 'error', join(dir, 'missing.mp4')], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume();
    child.once('close', () => setImmediate(resolve));
  });

  const text = readFileSync(file, 'utf8');
  assert.match(text, /OpenChatCut started/);
  assert.match(text, /\[error\] \[probe\] import failed for LTX-2\.5_i2v_00020_\.mp4/);
  assert.match(text, /\[error\] \[media-process\] ffprobe(\.exe)? exited 1: -v error .*missing\.mp4/);
  assert.match(text, /No such file or directory|cannot find|does not exist/i, 'stderr tail included');
  assert.doesNotMatch(text, /sk-live-abcdefghijklmnopqrstuvwxyz/, 'credentials are redacted');

  // Rotation at 5 MB keeps older files.
  const chunk = 'frame render ok '.repeat(640);
  for (let i = 0; i < 600; i += 1) writeAppLog('info', chunk);
  assert.ok(existsSync(`${file}.1`), 'the log rotates');
  assert.ok(readFileSync(file).length < 5 * 1024 * 1024);
} finally {
  await rm(dir, { recursive: true, force: true });
}
process.stdout.write('app-log.verify: console, failed media runs and redaction reach app.log; rotation works\n');
