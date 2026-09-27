import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { renderDirectHardware } from './direct-hardware.mjs';
const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('@ffprobe-installer/ffprobe').path;
const run = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'openchatcut-direct-hardware-'));
const binaries = join(root, 'binaries');
const executable = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
const input = join(root, 'hardware.mp4');
const output = join(root, 'final.mp4');
try {
  await mkdir(binaries);
  await copyFile(ffmpeg, join(binaries, executable));
  await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=24:d=0.25',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-t', '0.25', '-c:v', 'libx264', '-c:a', 'libmp3lame', '-y', input,
  ]);
  let renderOptions;
  const result = await renderDirectHardware({
    render: async (options) => {
      renderOptions = options;
      await copyFile(input, options.outputLocation);
      return 'rendered';
    },
    options: { outputLocation: output },
    binariesDirectory: binaries,
  });
  assert.equal(result, 'rendered');
  assert.equal(renderOptions.audioCodec, 'mp3');
  assert.equal(renderOptions.binariesDirectory, binaries);
  const { stdout } = await run(ffprobe, [
    '-v', 'error', '-show_entries', 'stream=codec_name,codec_type', '-of', 'json', output,
  ]);
  const streams = JSON.parse(stdout).streams;
  assert.ok(streams.some((stream) => stream.codec_type === 'video' && stream.codec_name === 'h264'));
  assert.ok(streams.some((stream) => stream.codec_type === 'audio' && stream.codec_name === 'aac'));
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log('direct hardware AAC finalization verification passed');

// Software renders on an ffmpeg without libfdk_aac (Windows' ffmpeg-static):
// the encoder probe says so, and the remux path yields AAC audio.
{
  const { ffmpegHasFdkAac, renderWithAacRemux } = await import('./direct-hardware.mjs');
  const { aacFallbackFor } = await import('./render.mjs');
  const root2 = await mkdtemp(join(tmpdir(), 'openchatcut-aac-remux-'));
  try {
    const bin2 = join(root2, 'binaries');
    await mkdir(bin2);
    await copyFile(ffmpeg, join(bin2, executable));
    assert.equal(await ffmpegHasFdkAac(bin2), false, 'ffmpeg-static has no libfdk_aac');
    assert.equal(await ffmpegHasFdkAac(null), true, "Remotion's own binaries are trusted to carry it");
    assert.equal(aacFallbackFor('h264', false), 'remux');
    assert.equal(aacFallbackFor('prores', false), 'pcm');
    assert.equal(aacFallbackFor('vp8', false), 'none');
    assert.equal(aacFallbackFor('h264', true), 'none');
    const src = join(root2, 'src.mp4');
    await run(ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=24:d=0.25',
      '-f', 'lavfi', '-i', 'sine=f=440:r=48000',
      '-t', '0.25', '-c:v', 'libx264', '-c:a', 'libmp3lame', '-y', src,
    ]);
    const out2 = join(root2, 'out.mp4');
    let seen;
    await renderWithAacRemux({
      render: async (options) => { seen = options; await copyFile(src, options.outputLocation); },
      options: { outputLocation: out2, binariesDirectory: bin2 },
      binariesDirectory: bin2,
    });
    assert.equal(seen.audioCodec, 'mp3');
    const { stdout } = await run(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type', '-of', 'json', out2]);
    assert.ok(JSON.parse(stdout).streams.some((s) => s.codec_type === 'audio' && s.codec_name === 'aac'));
  } finally {
    await rm(root2, { recursive: true, force: true });
  }
  console.log('software AAC fallback verification passed');
}
