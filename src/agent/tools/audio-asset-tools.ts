import type { AgentContext } from '../context';
import type { AudioAsset } from '../../audio/library';
import { defaultTrackId, resolveTrackId, trackAlias } from '../../editor/types';

export { AUDIO_ASSET_TOOL_NAMES } from './schemas/audio-asset-tools';

type Args = Record<string, unknown>;

function availableAudio(ctx: AgentContext) {
  const builtins = ctx.audio.map((asset) => ({ ...asset, source: 'builtin' as const }));
  const project = ctx.getDoc().assets
    .filter((asset) => asset.kind === 'audio')
    .map((asset) => ({ ...asset, category: 'project', source: 'project' as const }));
  return [...builtins, ...project];
}

function commandAudio(asset: ReturnType<typeof availableAudio>[number]): AudioAsset {
  const category: AudioAsset['category'] = asset.source === 'project'
    ? 'music'
    : asset.category as AudioAsset['category'];
  return {
    id: asset.id,
    name: asset.name,
    category,
    src: asset.src,
    durationInFrames: asset.durationInFrames,
  };
}

/** Real duration of a project file via the app's ffprobe, or null when unknown. */
async function probedDurationFrames(src: string, fps: number): Promise<number | null> {
  try {
    const res = await fetch('/api/probe-media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: src }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { probe?: { format?: { duration?: unknown }; streams?: Array<{ codec_type?: unknown; duration?: unknown }> } };
    const audio = data.probe?.streams?.find((stream) => stream.codec_type === 'audio');
    const seconds = Number(data.probe?.format?.duration ?? audio?.duration);
    return Number.isFinite(seconds) && seconds > 0 ? Math.max(1, Math.round(seconds * fps)) : null;
  } catch {
    return null;
  }
}

type TimelineState = ReturnType<AgentContext['getState']>;

/** Clips on `track` that [start, start + duration) would overlap. */
function overlapping(state: TimelineState, track: string, start: number, duration: number) {
  return state.items.filter((item) => item.track === track
    && item.startFrame < start + duration && start < item.startFrame + item.durationInFrames);
}

export function execAudioAssetTool(name: string, args: Args, ctx: AgentContext): unknown {
  const choices = availableAudio(ctx);
  if (name === 'list_audio') {
    return choices.map((asset) => ({
      id: asset.id,
      name: asset.name,
      category: asset.category,
      source: asset.source,
      seconds: Math.round(asset.durationInFrames / (ctx.getState().fps || 30)),
    }));
  }
  const q = String(args.audioName ?? '').trim().toLowerCase();
  if (!q) return { error: 'audioName is required; call list_audio to choose an asset' };
  const asset = choices.find((candidate) => candidate.id.toLowerCase() === q)
    ?? choices.find((candidate) => candidate.id.toLowerCase().startsWith(q))
    ?? choices.find((candidate) => candidate.name.toLowerCase().includes(q));
  if (!asset) return { error: `no audio matching "${args.audioName}"`, available: choices.map((a) => a.name) };
  const state = ctx.getState();
  const requestedTrack = args.track ?? 'A1';
  const resolvedTrack = resolveTrackId(state, requestedTrack, 'audio');
  if (args.track != null && !resolvedTrack) {
    return {
      error: `audio track "${String(args.track)}" does not exist yet. Create it first with edit_track action=create json={"trackType":"audio","name":"${String(args.track)}"} (or omit track to place on the default audio track).`,
    };
  }
  const track = resolvedTrack ?? defaultTrackId(state, 'audio');
  if (!track) return { error: 'no audio track exists; create one with edit_track action=create json={"trackType":"audio"}' };
  const requestedStart = typeof args.startFrame === 'number' && Number.isFinite(args.startFrame)
    ? Math.max(0, Math.round(args.startFrame))
    : undefined;
  return placeAudio(ctx, asset, track, requestedStart, args.ripple === true);
}

async function placeAudio(
  ctx: AgentContext,
  asset: ReturnType<typeof availableAudio>[number],
  track: string,
  requestedStart: number | undefined,
  ripple: boolean,
): Promise<unknown> {
  const fps = ctx.getState().fps || 30;
  // A pool asset added moments ago can still carry a placeholder duration;
  // use the file's real length so the clip is not cut short.
  const probed = asset.source === 'project' ? await probedDurationFrames(asset.src, fps) : null;
  const audio = { ...commandAudio(asset), ...(probed ? { durationInFrames: probed } : {}) };
  const state = ctx.getState();
  // Never move a clip away from the frame the caller asked for: say why instead.
  // Ripple pushes clips that start at or after the frame; one that starts
  // earlier and runs across it stays put and would still block.
  if (requestedStart !== undefined) {
    const blocking = ripple
      ? overlapping(state, track, requestedStart, 1).filter((item) => item.startFrame < requestedStart)
      : overlapping(state, track, requestedStart, audio.durationInFrames);
    if (blocking.length) {
      return {
        error: `track ${trackAlias(state, track)} is occupied at frames ${requestedStart}–${requestedStart + audio.durationInFrames} by ${blocking.map((item) => `${item.id} (${item.startFrame}–${item.startFrame + item.durationInFrames})`).join(', ')}`,
        hint: 'Pass ripple:true to push later clips right, choose another audio track, or pick a free startFrame.',
      };
    }
  }
  const placed = ctx.commands.addAudio(audio, { track, startFrame: requestedStart, ripple });
  const item = ctx.getState().items.find((candidate) => candidate.id === placed.itemId);
  if (!item) return { error: `audio was not added (track ${trackAlias(ctx.getState(), track)} may be locked)` };
  return {
    ok: true,
    added: asset.name,
    assetId: asset.id,
    itemId: placed.itemId,
    sourceAssetId: placed.sourceAssetId,
    source: asset.source,
    trackId: track,
    track: trackAlias(ctx.getState(), track),
    startFrame: item.startFrame,
    durationInFrames: item.durationInFrames,
    ...(probed && probed !== asset.durationInFrames ? { note: `duration taken from the file (${probed} frames), not the pool entry (${asset.durationInFrames})` } : {}),
  };
}
