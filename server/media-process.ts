import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
  type SpawnOptionsWithStdioTuple,
  type SpawnOptionsWithoutStdio,
  type StdioNull,
  type StdioPipe,
} from 'node:child_process';
import { availableParallelism, constants, setPriority } from 'node:os';
import { basename } from 'node:path';

/** Cap ffmpeg worker threads so a single encode cannot saturate the whole
 * machine and starve the editor or other Node/Electron applications. */
export function ffmpegThreadCount(cores: number = availableParallelism()): number {
  const override = Number(process.env.OPENCHATCUT_FFMPEG_THREADS);
  if (Number.isFinite(override) && override >= 1) {
    return Math.max(1, Math.min(Math.floor(override), Math.max(1, cores)));
  }
  return Math.max(1, Math.ceil(cores * 0.75));
}

/** Codec-scoped thread option. Place it in each input or output option group
 * that should be capped; an option before `-i` does not limit output encoders. */
export function ffmpegThreadArgs(cores: number = availableParallelism()): string[] {
  return ['-threads', String(ffmpegThreadCount(cores))];
}

/**
 * Spawn a media tool (ffmpeg/ffprobe) at below-normal OS priority so import,
 * normalization, preview derivatives and export never compete with the user's
 * foreground applications for CPU time. Best-effort on every platform.
 */
const FAILURE_STDERR_TAIL = 4_000;

/** A failed ffmpeg/ffprobe run goes to the log with its arguments and stderr
 *  tail, whatever the caller then does with the error. */
function logFailedRun(child: ChildProcess, command: string, args: readonly string[]): void {
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderr = `${stderr}${String(chunk)}`.slice(-FAILURE_STDERR_TAIL);
  });
  child.once('error', (error) => {
    console.error(`[media-process] ${basename(command)} could not start: ${error.message}`);
  });
  child.once('close', (code, signal) => {
    if (code === 0) return;
    const how = code === null ? `killed (${signal ?? 'signal'})` : `exited ${code}`;
    const line = `[media-process] ${basename(command)} ${how}: ${args.join(' ')}${stderr ? `\n${stderr.trim()}` : ''}`;
    if (code === null) console.warn(line);
    else console.error(line);
  });
}

export function spawnMediaProcess(
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
): ChildProcessWithoutNullStreams;
export function spawnMediaProcess(
  command: string,
  args: string[],
  options: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe>,
): ChildProcessWithoutNullStreams;
export function spawnMediaProcess(
  command: string,
  args: string[],
  options: SpawnOptionsWithStdioTuple<StdioNull, StdioNull, StdioPipe>,
): ChildProcessWithoutNullStreams;
export function spawnMediaProcess(
  command: string,
  args: string[],
  options: SpawnOptions,
): ChildProcess;
export function spawnMediaProcess(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): ChildProcess {
  const child = spawn(command, args, options);
  logFailedRun(child, command, args);
  if (child.pid !== undefined) {
    try {
      setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {
      // Priority adjustment is best-effort; the child still runs.
    }
  }
  return child;
}
