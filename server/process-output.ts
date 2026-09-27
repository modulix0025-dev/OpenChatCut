// Bounded, lossless collection of a child process's output, plus the ffprobe
// query every import path uses.
//
// The import probes used to keep only the last 1,000,000 characters of
// ffprobe's JSON. Videos from ComfyUI embed the whole workflow and prompt in
// their metadata, which pushes that JSON to ~2 MB, so the head was cut off,
// JSON.parse failed, and the editor silently dropped the clip. Output is now
// kept whole up to an explicit cap and decoded once (so multi-byte characters
// split across chunks survive), and the probes stop asking for tags at all.

/** Generous cap for machine-readable output; past it the command fails loudly. */
export const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface OutputCollector {
  push(chunk: Buffer | string): void;
  /** Everything collected, decoded as UTF-8. Throws if the cap was exceeded. */
  text(): string;
  readonly overflowed: boolean;
}

export function collectOutput(label: string, limitBytes = MAX_PROCESS_OUTPUT_BYTES): OutputCollector {
  const chunks: Buffer[] = [];
  let size = 0;
  let overflowed = false;
  return {
    push(chunk) {
      if (overflowed) return;
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      if (size > limitBytes) {
        overflowed = true;
        chunks.length = 0;
        return;
      }
      chunks.push(buffer);
    },
    text() {
      if (overflowed) {
        throw new Error(`${label} output exceeded ${Math.round(limitBytes / (1024 * 1024))} MB; refusing to parse a truncated result`);
      }
      return Buffer.concat(chunks).toString('utf8');
    },
    get overflowed() {
      return overflowed;
    },
  };
}

/**
 * ffprobe fields the import pipeline reads. Container and stream tags are
 * deliberately absent (only `rotate` is asked for): they carry arbitrary,
 * sometimes multi-megabyte, metadata that no import decision depends on.
 */
export const IMPORT_PROBE_ENTRIES = [
  'stream=index,codec_type,codec_name,profile,width,height,pix_fmt,bit_rate,avg_frame_rate,r_frame_rate,nb_frames,duration,channels,sample_rate',
  'stream_tags=rotate',
  'stream_side_data=rotation',
  'format=duration,size,bit_rate,format_name',
].join(':');

/** `ffprobe` arguments for a metadata-free JSON probe of `path`. */
export function importProbeArgs(path: string): string[] {
  return ['-v', 'error', '-show_entries', IMPORT_PROBE_ENTRIES, '-of', 'json', path];
}
