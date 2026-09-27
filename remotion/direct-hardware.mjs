import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';

const MAX_ERROR_OUTPUT = 32_768;

function ffmpegPath(binariesDirectory) {
  return path.join(binariesDirectory, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
}

export function remuxHardwareOutputToAac({ input, output, binariesDirectory, signal }) {
  const args = [
    '-hide_banner', '-y', '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '320k',
    '-movflags', '+faststart', output,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(binariesDirectory), args, { stdio: ['ignore', 'ignore', 'pipe'], signal });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-MAX_ERROR_OUTPUT); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`hardware encoder finalization failed (${code ?? 'unknown'}): ${stderr}`));
    });
  });
}

const fdkAacSupport = new Map();

/**
 * Whether the ffmpeg in `binariesDirectory` has libfdk_aac, the encoder
 * Remotion names for `audioCodec: 'aac'`. Remotion's own ffmpeg does; the
 * ffmpeg-static build that Windows mirrors in for hardware encoders does not,
 * so software H.264 renders there failed with "Error selecting an encoder".
 */
export function ffmpegHasFdkAac(binariesDirectory, { spawnImpl = spawn } = {}) {
  if (!binariesDirectory) return Promise.resolve(true); // Remotion's own binaries
  const binary = ffmpegPath(binariesDirectory);
  let pending = fdkAacSupport.get(binary);
  if (!pending) {
    pending = new Promise((resolve) => {
      let child;
      try {
        child = spawnImpl(binary, ['-hide_banner', '-encoders'], { stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        resolve(false);
        return;
      }
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.once('error', () => resolve(false));
      child.once('close', () => resolve(/\blibfdk_aac\b/.test(stdout)));
    });
    fdkAacSupport.set(binary, pending);
  }
  return pending;
}

/**
 * Render MP3 audio, then remux it to standard AAC with ffmpeg's built-in
 * encoder. Used by the hardware pass and by any render whose ffmpeg lacks
 * libfdk_aac.
 */
export async function renderWithAacRemux({ render, options, binariesDirectory, signal }) {
  const output = options.outputLocation;
  if (!output) return render(options);
  const intermediate = `${output}.aac-remux.mp4`;
  try {
    const result = await render({ ...options, outputLocation: intermediate, audioCodec: 'mp3' });
    await remuxHardwareOutputToAac({ input: intermediate, output, binariesDirectory, signal });
    return result;
  } finally {
    await rm(intermediate, { force: true }).catch(() => {});
  }
}

/** Keep Remotion's custom hardware video pass fast, then normalize MP3 audio to standard AAC. */
export async function renderDirectHardware({ render, options, binariesDirectory, signal }) {
  const output = options.outputLocation;
  if (!output) return render(options);
  const intermediate = `${output}.direct-hardware.mp4`;
  try {
    const result = await render({
      ...options,
      outputLocation: intermediate,
      binariesDirectory,
      audioCodec: 'mp3',
    });
    await remuxHardwareOutputToAac({ input: intermediate, output, binariesDirectory, signal });
    return result;
  } finally {
    await rm(intermediate, { force: true }).catch(() => {});
  }
}
