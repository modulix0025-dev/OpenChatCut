// ComfyUI provider against a fake ComfyUI HTTP API: workflow library and
// manifests, value injection, image runs (with a reference upload), video
// submit and resume-by-prompt-id, request validation, and metadata stripping.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { findComfyWorkflow, injectComfyValues, listComfyWorkflows, parseComfyManifest } from './comfyui-client.ts';
import { comfyDimensions, generateComfyImages, generateComfyVideo, stripVideoMetadata, type ComfySettings } from './comfyui-provider.ts';
import { validateVideoRequest } from './video-validation.ts';
import { validateImageRequest } from './image.ts';

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static') as string;
const ffprobe = (require('@ffprobe-installer/ffprobe') as { path: string }).path;
const run = promisify(execFile);
const dir = await mkdtemp(join(tmpdir(), 'openchatcut-comfyui-'));

try {
  // ── Workflow library ────────────────────────────────────────────────────
  const imageGraph = {
    3: { class_type: 'KSampler', inputs: { seed: 1, steps: 20 } },
    5: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512 } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: 'old' } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: '' } },
    9: { class_type: 'SaveImage', inputs: {} },
    10: { class_type: 'LoadImage', inputs: { image: 'x.png' } },
  };
  await writeFile(join(dir, 'flux-portrait.json'), JSON.stringify(imageGraph));
  await writeFile(join(dir, 'flux-portrait.manifest.json'), JSON.stringify({
    name: 'Flux portrait', kind: 'image',
    inputs: {
      prompt: { node: '6', field: 'text' }, negativePrompt: { node: '7', field: 'text' },
      seed: { node: '3', field: 'seed' }, width: { node: '5', field: 'width' }, height: { node: '5', field: 'height' },
      image: { node: '10', field: 'image' },
    },
    output: { node: '9' },
  }));
  await writeFile(join(dir, 'ltx-i2v.json'), JSON.stringify({
    6: { inputs: { text: '' } }, 12: { inputs: { length: 97 } }, 40: { inputs: { frame_rate: 24 } }, 50: { inputs: {} },
  }));
  await writeFile(join(dir, 'ltx-i2v.manifest.json'), JSON.stringify({
    name: 'LTX 2.5 i2v', kind: 'video',
    inputs: { prompt: { node: '6', field: 'text' }, frames: { node: '12', field: 'length' }, fps: { node: '40', field: 'frame_rate' } },
    output: { node: '50' },
  }));
  await writeFile(join(dir, 'broken.manifest.json'), JSON.stringify({ kind: 'image', inputs: {}, output: { node: '1' } }));
  await writeFile(join(dir, 'broken.json'), '{}');
  await writeFile(join(dir, 'ui-export.json'), JSON.stringify({ nodes: [], links: [] }));
  await writeFile(join(dir, 'ui-export.manifest.json'), JSON.stringify({ kind: 'image', inputs: { prompt: { node: '6', field: 'text' } }, output: { node: '9' } }));

  const library = listComfyWorkflows(dir);
  assert.deepEqual(library.workflows.map((workflow) => workflow.id), ['flux-portrait', 'ltx-i2v', 'ui-export']);
  assert.match(library.problems.join('\n'), /broken: inputs\.prompt is required/);
  assert.throws(() => parseComfyManifest('x', { kind: 'audio', inputs: {}, output: { node: '1' } }), /kind must be/);
  assert.throws(() => parseComfyManifest('x', { kind: 'image', inputs: { prompt: { node: '1' } }, output: { node: '1' } }), /needs \{ "node"/);
  assert.equal(findComfyWorkflow(dir, 'Flux portrait', 'image').id, 'flux-portrait', 'found by name');
  assert.equal(findComfyWorkflow(dir, '', 'video').id, 'ltx-i2v', 'the only video workflow is the default');
  assert.throws(() => findComfyWorkflow(dir, 'nope', 'image'), /Available: flux-portrait \(Flux portrait\), ui-export/);

  const injected = injectComfyValues(imageGraph, findComfyWorkflow(dir, 'flux-portrait', 'image'),
    { prompt: 'a cat', negativePrompt: 'blurry', seed: 42, width: 1024, height: 768, uploadedImage: 'ref.png' }) as typeof imageGraph;
  assert.equal(injected[6].inputs.text, 'a cat');
  assert.equal(injected[7].inputs.text, 'blurry');
  assert.equal(injected[3].inputs.seed, 42);
  assert.equal(injected[3].inputs.steps, 20, 'other inputs are left alone');
  assert.deepEqual([injected[5].inputs.width, injected[5].inputs.height], [1024, 768]);
  assert.equal(injected[10].inputs.image, 'ref.png');
  assert.equal(imageGraph[6].inputs.text, 'old', 'the stored workflow is not mutated');
  const video = injectComfyValues({ 6: { inputs: {} }, 12: { inputs: {} }, 40: { inputs: {} }, 50: { inputs: {} } },
    findComfyWorkflow(dir, 'ltx-i2v', 'video'), { prompt: 'waves', durationSeconds: 4 }) as Record<string, { inputs: Record<string, unknown> }>;
  assert.equal(video[12].inputs.length, 96, '4 s at 24 fps');
  assert.equal(video[40].inputs.frame_rate, 24);
  assert.throws(() => injectComfyValues({ 9: {} }, findComfyWorkflow(dir, 'flux-portrait', 'image'), { prompt: 'x' }), /node 6 \(prompt\)/);

  // ── Fake ComfyUI server ────────────────────────────────────────────────
  const calls: string[] = [];
  const submitted: Array<Record<string, { inputs: Record<string, unknown> }>> = [];
  let polls = 0;
  let nextId = 0;
  const videoPrompts = new Set<string>(['pv-resume']);
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer tunnel-token', 'the optional token is sent');
    if (url.pathname === '/upload/image') return Response.json({ name: 'ref-upload.png', subfolder: '' });
    if (url.pathname === '/prompt') {
      const body = JSON.parse(String(init?.body)) as { prompt: Record<string, { inputs: Record<string, unknown> }> };
      submitted.push(body.prompt);
      const id = `p${nextId += 1}`;
      if ('50' in body.prompt) videoPrompts.add(id);
      return Response.json({ prompt_id: id });
    }
    if (url.pathname.startsWith('/history/')) {
      const id = decodeURIComponent(url.pathname.slice('/history/'.length));
      polls += 1;
      if (polls % 2 === 1) return Response.json({});
      const node = videoPrompts.has(id) ? '50' : id === 'p-wrong-node' ? '99' : '9';
      const files = node === '50' ? { videos: [{ filename: `${id}.mp4`, subfolder: 'out', type: 'output' }] } : { images: [{ filename: `${id}.png`, subfolder: '', type: 'output' }] };
      return Response.json({ [id]: { status: { status_str: 'success', completed: true }, outputs: { [node]: files } } });
    }
    if (url.pathname === '/view') return new Response(new Uint8Array([137, 80, 78, 71, Number(url.searchParams.get('filename')?.length ?? 0)]), { headers: { 'content-type': 'image/png' } });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  const settings: ComfySettings = { baseUrl: 'http://127.0.0.1:8188/', apiKey: 'tunnel-token', workflowDir: dir, fetchImpl: fakeFetch };

  const reference = join(dir, 'reference.png');
  await writeFile(reference, 'png');
  const images = await generateComfyImages({ workflow: 'flux-portrait', prompt: 'a cat', seed: 7, count: 2, width: 1024, height: 1024, imagePath: reference }, settings);
  assert.equal(images.length, 2);
  assert.ok(Buffer.from(images[0]!.b64_json, 'base64').subarray(0, 4).equals(Buffer.from([137, 80, 78, 71])));
  assert.deepEqual(submitted.map((graph) => graph[3]!.inputs.seed), [7, 8], 'each image gets its own seed');
  assert.equal(submitted[0]![10]!.inputs.image, 'ref-upload.png', 'the reference image is uploaded and injected');
  assert.ok(calls.includes('POST /upload/image'));

  const registered: string[] = [];
  calls.length = 0;
  const url = await generateComfyVideo({ workflow: 'ltx-i2v', prompt: 'waves', durationSeconds: 3 }, async (provider, taskId) => {
    registered.push(`${provider}:${taskId}`);
  }, undefined, settings);
  assert.match(url, /^http:\/\/127\.0\.0\.1:8188\/view\?filename=p3\.mp4&subfolder=out&type=output$/);
  assert.deepEqual(registered, ['comfyui:comfyui:p3'], 'the prompt id is registered for resume');
  calls.length = 0;
  const resumed = await generateComfyVideo({ workflow: 'ltx-i2v', prompt: 'waves' }, async () => {
    throw new Error('a resumed job must not register again');
  }, 'comfyui:pv-resume', settings);
  assert.match(resumed, /filename=pv-resume\.mp4/);
  assert.ok(!calls.includes('POST /prompt'), 'resume only polls');

  polls = 1;
  await assert.rejects(generateComfyVideo({ workflow: 'ltx-i2v', prompt: 'x' }, async () => undefined, 'comfyui:p-wrong-node', settings),
    /finished without a file on output node 50 \(nodes with output: 99\)/, 'a finished run with no output fails at once');
  await assert.rejects(generateComfyImages({ prompt: 'x', count: 1 }, { ...settings, baseUrl: '' }), /ComfyUI is not configured/);
  await assert.rejects(generateComfyImages({ prompt: 'x', count: 1, workflow: 'ui-export' }, settings), /not an API-format workflow/);

  // ── Request validation ─────────────────────────────────────────────────
  const validVideo = validateVideoRequest({ model: 'comfyui', prompt: 'waves', workflow: 'ltx-i2v', durationSeconds: 4 });
  assert.equal(validVideo.model, 'comfyui');
  assert.throws(() => validateVideoRequest({ model: 'comfyui', prompt: 'x', refImagePaths: ['/media/uploads/a.png', '/media/uploads/b.png'] }), /at most one reference image/);
  assert.throws(() => validateVideoRequest({ model: 'comfyui', prompt: 'x', durationSeconds: 500 }), /between 1 and 120/);
  const validImage = validateImageRequest({ model: 'comfyui', prompt: 'a cat', workflow: 'flux-portrait', count: 2 });
  assert.equal(validImage.workflow, 'flux-portrait');
  assert.throws(() => validateImageRequest({ model: 'comfyui', prompt: 'x', count: 9 }), /between 1 and 4/);
  assert.deepEqual(comfyDimensions('16:9', '720p'), { width: 1280, height: 720 });
  assert.deepEqual(comfyDimensions('9:16', '1080p'), { width: 1088, height: 1920 });
  assert.equal(comfyDimensions(undefined, '720p'), null);

  // ── Metadata stripping ─────────────────────────────────────────────────
  const meta = join(dir, 'meta.txt');
  await writeFile(meta, `;FFMETADATA1\ncomment=${JSON.stringify({ workflow: 'x'.repeat(300_000) }).replace(/[\\=;#\n]/g, (ch) => `\\${ch}`)}\n`);
  const clip = join(dir, 'clip.mp4');
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:r=24:d=1',
    '-i', meta, '-map', '0:v', '-map_metadata', '1', '-t', '1', '-c:v', 'libx264', clip]);
  const before = (await stat(clip)).size;
  await stripVideoMetadata(clip);
  assert.ok((await stat(clip)).size < before - 200_000, 'the embedded workflow is gone');
  const probe = await run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', clip]);
  const parsed = JSON.parse(probe.stdout) as { streams: Array<{ codec_name: string }>; format: { tags?: Record<string, string> } };
  assert.equal(parsed.streams[0]?.codec_name, 'h264', 'the video stream is copied unchanged');
  assert.equal(parsed.format.tags?.comment, undefined);
} finally {
  await rm(dir, { recursive: true, force: true });
}
console.log('comfyui.verify: workflows, injection, image and video runs, resume, validation, metadata stripping');
