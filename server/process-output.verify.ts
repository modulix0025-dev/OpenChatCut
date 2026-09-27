// Import probes on videos with multi-megabyte metadata (ComfyUI embeds the
// workflow and prompt in every render). They used to keep only the last 1 MB
// of ffprobe's JSON, fail to parse it, and drop the clip without a message.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { collectOutput, importProbeArgs } from './process-output.ts';
import { probeVideo } from './media-normalization.ts';
import { probeDirectoryMedia } from './directory-watch-import.ts';
import { probeMediaFile } from './plugins/probe-media.ts';

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static') as string;
const ffprobe = (require('@ffprobe-installer/ffprobe') as { path: string }).path;
const run = promisify(execFile);

// Collector: whole output, decoded once, explicit failure past the cap.
{
  const euro = Buffer.from('€');
  const c = collectOutput('t');
  c.push(euro.subarray(0, 1));
  c.push(euro.subarray(1));
  assert.equal(c.text(), '€', 'a multi-byte character split across chunks survives');
  const small = collectOutput('ffprobe', 4);
  small.push('12345');
  assert.equal(small.overflowed, true);
  assert.throws(() => small.text(), /ffprobe output exceeded/);
}

const root = await mkdtemp(join(tmpdir(), 'openchatcut-probe-metadata-'));
try {
  // ~2 MB of workflow JSON as the container comment, like a ComfyUI MP4.
  const workflow = JSON.stringify({
    nodes: Array.from({ length: 1000 }, (_, id) => ({ id, type: 'KSampler', text: 'x'.repeat(2000) })),
  });
  const escaped = workflow.replace(/[\\=;#\n]/g, (ch) => `\\${ch}`);
  const metadata = join(root, 'meta.txt');
  await writeFile(metadata, `;FFMETADATA1\ncomment=${escaped}\n`);
  const plain = join(root, 'plain.mp4');
  await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=blue:s=64x48:r=24:d=1',
    '-f', 'lavfi', '-i', 'sine=f=440:r=48000',
    '-i', metadata, '-map', '0:v', '-map', '1:a', '-map_metadata', '2',
    '-t', '1', '-c:v', 'libx264', '-c:a', 'aac', plain,
  ]);
  const video = join(root, 'LTX-2.5_i2v_00020_.mp4');
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-display_rotation', '90', '-i', plain, '-c', 'copy', video]);

  const full = await run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', video], { maxBuffer: 64 * 1024 * 1024 });
  assert.ok(full.stdout.length > 1_000_000, `fixture reproduces the >1 MB ffprobe output (${full.stdout.length})`);
  const focused = await run(ffprobe, importProbeArgs(video));
  assert.ok(focused.stdout.length < 10_000, 'the import query leaves the metadata out');

  const meta = await probeVideo(video);
  assert.equal(meta.videoCodec, 'h264');
  assert.equal(meta.hasAudio, true);
  assert.equal(meta.audioCodec, 'aac');
  assert.deepEqual([meta.width, meta.height], [48, 64], 'display rotation still swaps the dimensions');
  assert.ok(meta.duration > 0.9 && meta.duration < 1.1);
  assert.equal(meta.frameCount, 24);

  const watched = await probeDirectoryMedia(video, 'video');
  assert.equal(watched.width, 48);
  assert.equal(watched.height, 64);

  const raw = await probeMediaFile(video) as { streams: Array<Record<string, unknown>>; format: Record<string, unknown> };
  assert.equal(raw.streams.length, 2);
  assert.ok(Number(raw.format.duration) > 0.9);
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log('import probes survive multi-megabyte metadata: ok');
