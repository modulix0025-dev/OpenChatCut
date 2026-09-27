import assert from 'node:assert/strict';
import { makeDraft } from '../../editor/store.ts';
import type { ProjectDoc, Timeline } from '../../editor/types.ts';
import type { AgentContext } from '../context.ts';
import { execAudioAssetTool } from './audio-asset-tools.ts';
import { resolveMusicTarget } from './music-intelligence-plan.ts';
import { CURRENT_PROJECT_VERSION } from '../../../shared/project-version';

const timeline: Timeline = {
  id: 'tl_audio_assets',
  name: 'audio assets',
  order: 0,
  fps: 30,
  width: 1920,
  height: 1080,
  items: [],
  selectedId: null,
  trackOrder: ['V1', 'A1'],
  tracks: {
    V1: { kind: 'video', name: 'Video' },
    A1: { kind: 'audio', name: 'Audio' },
  },
};
const doc: ProjectDoc = {
  version: CURRENT_PROJECT_VERSION,
  assets: [{
    id: 'asset_voice_qa',
    name: 'Generated Voice',
    kind: 'audio',
    src: '/media/uploads/generated.mp3',
    durationInFrames: 90,
    sourceFilename: 'generated.mp3',
    sourceContentHash: 'a'.repeat(64),
    originalFilePath: '/fixtures/generated.mp3',
  }],
  mediaFolders: [],
  timelines: [timeline],
  activeTimelineId: timeline.id,
};
const draft = makeDraft(doc);
const ctx: AgentContext = {
  commands: draft.commands,
  getState: draft.getState,
  getDoc: draft.getDoc,
  getCreativeMode: () => null,
  templates: [],
  audio: [],
};

const listed = execAudioAssetTool('list_audio', {}, ctx) as { id: string; source: string }[];
assert.deepEqual(listed, [{
  id: 'asset_voice_qa',
  name: 'Generated Voice',
  category: 'project',
  source: 'project',
  seconds: 3,
}]);
assert.deepEqual(
  execAudioAssetTool('add_audio', {}, ctx),
  { error: 'audioName is required; call list_audio to choose an asset' },
);
assert.deepEqual(
  execAudioAssetTool('add_audio', { audioName: 'asset_voice', track: 'A9' }, ctx),
  { error: 'audio track "A9" does not exist yet. Create it first with edit_track action=create json={"trackType":"audio","name":"A9"} (or omit track to place on the default audio track).' },
);
const added = await execAudioAssetTool('add_audio', {
  audioName: 'asset_voice',
  track: 'A1',
  startFrame: 15,
}, ctx) as { ok: boolean; source: string; startFrame: number; durationInFrames: number };
assert.equal(added.startFrame, 15, 'the result reports where the clip landed');
assert.equal(added.durationInFrames, 90);
assert.equal(added.ok, true);
assert.equal(added.source, 'project');
assert.equal(draft.getState().items[0]?.src, '/media/uploads/generated.mp3');
assert.equal(draft.getState().items[0]?.startFrame, 15);
assert.equal(draft.getState().items[0]?.sourceAssetId, 'asset_voice_qa', 'project audio retains its pool master');
assert.ok(draft.getState().items[0]?.sourceRevision, 'project audio captures its pool source revision');
assert.equal(draft.getState().items[0]?.sourceFilename, 'generated.mp3', 'project audio retains its source filename');
assert.equal(draft.getState().items[0]?.sourceContentHash, 'a'.repeat(64), 'project audio retains its content identity');
assert.equal(draft.getState().items[0]?.originalFilePath, '/fixtures/generated.mp3', 'desktop audio retains its local source path');
draft.takeActions();

const builtin = { id: 'builtin_qa', name: 'Builtin QA', category: 'music' as const, src: '/audio/qa.mp3', durationInFrames: 60 };
const builtinCtx = { ...ctx, audio: [builtin] };
const builtinAdded = await execAudioAssetTool('add_audio', { audioName: 'builtin_qa' }, builtinCtx) as { itemId: string; sourceAssetId: string };
assert.equal(builtinAdded.sourceAssetId, 'builtin_qa', 'builtins get a deterministic pool master');
assert.equal(draft.getDoc().assets.filter((asset) => asset.id === builtinAdded.sourceAssetId).length, 1, 'builtins create one pool asset');
assert.equal(draft.getDoc().assets.find((asset) => asset.id === builtinAdded.sourceAssetId)?.sourceFilename, 'qa.mp3', 'builtins retain a relinkable source filename');
assert.equal(draft.getState().items.at(-1)?.sourceAssetId, builtinAdded.sourceAssetId, 'built-in clip links to pool master');
assert.equal(draft.getState().items.at(-1)?.id, builtinAdded.itemId, 'tool returns the placed clip id for follow-up analysis');
assert.equal(resolveMusicTarget({ itemId: builtinAdded.itemId }, builtinCtx).asset.id, builtinAdded.sourceAssetId, 'analyze_music resolves the placed clip to its canonical asset');
assert.ok(draft.getState().items.at(-1)?.sourceRevision, 'built-in clip captures its pool source revision');
const builtinActions = draft.takeActions();
assert.equal(builtinActions.length, 1, 'pool registration and placement are one undoable dispatch');
assert.equal(builtinActions[0]?.type, 'batch', 'new built-in audio uses an atomic batch');
await execAudioAssetTool('add_audio', { audioName: 'builtin_qa' }, builtinCtx);
assert.equal(draft.getDoc().assets.filter((asset) => asset.id === builtinAdded.sourceAssetId).length, 1, 'built-in pool master is reused');
const sameSource = { ...builtin, id: 'builtin_alias' };
const sameSourceAdded = await execAudioAssetTool('add_audio', { audioName: 'builtin_alias' }, { ...ctx, audio: [sameSource] }) as { sourceAssetId: string };
assert.equal(sameSourceAdded.sourceAssetId, builtinAdded.sourceAssetId, 'a unique same-source pool master is reused');
assert.equal(draft.getDoc().assets.filter((asset) => asset.src === builtin.src).length, 1, 'same-source placement does not duplicate pool assets');

// The requested frame is honoured or refused with a reason, never silently moved.
{
  const busy = await execAudioAssetTool('add_audio', { audioName: 'asset_voice', track: 'A1', startFrame: 30 }, ctx) as { error?: string; hint?: string };
  assert.match(busy.error ?? '', /occupied at frames 30–120/, 'an occupied spot is reported, not shifted to a gap');
  assert.match(busy.hint ?? '', /ripple:true/);
  const inside = await execAudioAssetTool('add_audio', { audioName: 'asset_voice', track: 'A1', startFrame: 30, ripple: true }, ctx) as { error?: string };
  assert.match(inside.error ?? '', /occupied/, 'ripple cannot insert inside a clip that starts earlier');
  const rippled = await execAudioAssetTool('add_audio', { audioName: 'asset_voice', track: 'A1', startFrame: 15, ripple: true }, ctx) as { ok?: boolean; startFrame?: number };
  assert.equal(rippled.ok, true);
  assert.equal(rippled.startFrame, 15, 'ripple places it exactly there and pushes the rest');
}

// A pool entry with a placeholder duration takes the file's real length.
{
  const placeholderDoc: ProjectDoc = {
    ...doc,
    assets: [{ id: 'asset_music_new', name: 'New Music', kind: 'audio', src: '/media/uploads/new.mp3', durationInFrames: 1 }],
    timelines: [{ ...timeline, items: [] }],
  };
  const placeholderDraft = makeDraft(placeholderDoc);
  const placeholderCtx: AgentContext = { ...ctx, commands: placeholderDraft.commands, getState: placeholderDraft.getState, getDoc: placeholderDraft.getDoc };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, probe: { format: { duration: '12.5' }, streams: [{ codec_type: 'audio' }] } }), { status: 200 })) as typeof fetch;
  try {
    const placed = await execAudioAssetTool('add_audio', { audioName: 'asset_music_new', startFrame: 45 }, placeholderCtx) as { durationInFrames?: number; startFrame?: number; note?: string };
    assert.equal(placed.durationInFrames, 375, '12.5 s at 30 fps, not the 1-frame placeholder');
    assert.equal(placed.startFrame, 45);
    assert.match(placed.note ?? '', /duration taken from the file/);
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log('generated/project audio placement check passed');
