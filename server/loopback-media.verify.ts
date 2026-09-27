// Export with loopback media: the app's own upload URLs map to local files,
// local services need the user's permission, and nothing else loosens the
// SSRF guard (private LAN hosts and other ports stay refused).
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyLoopbackMediaUrl, loopbackMediaFetch } from './loopback-media.ts';
import { materializeServerExportMedia } from './plugins/export-media-plan.ts';
import { registerCapabilityPrompter, resetCapabilityStateForTests, SECURITY_DIR_ENV } from './security/capabilities.ts';

const dir = await mkdtemp(join(tmpdir(), 'openchatcut-loopback-media-'));
process.env[SECURITY_DIR_ENV] = join(dir, 'security');
try {
  assert.deepEqual(classifyLoopbackMediaUrl('http://127.0.0.1:51734/media/uploads/music.mp3'),
    { kind: 'app-upload', path: '/media/uploads/music.mp3' });
  assert.equal(classifyLoopbackMediaUrl('http://localhost:8188/view?filename=a.png')?.kind, 'service');
  assert.equal(classifyLoopbackMediaUrl('http://[::1]:8188/view')?.kind, 'service');
  for (const other of ['http://192.168.1.5:8188/view', 'https://example.com/a.mp3', 'http://user:pw@127.0.0.1:1/x', 'file:///C:/a.mp3']) {
    assert.equal(classifyLoopbackMediaUrl(other), null, other);
  }

  await writeFile(join(dir, 'music.mp3'), 'mp3-bytes');
  const snapshot = {
    activeTimelineId: 't',
    assets: [],
    timelines: [{
      id: 't',
      items: [
        { id: 'music', kind: 'audio', src: 'http://127.0.0.1:51734/media/uploads/music.mp3' },
        { id: 'comfy', kind: 'image', src: 'http://127.0.0.1:8188/view?filename=out.png&type=output' },
      ],
    }],
  };
  const loopbackRequests: string[] = [];
  const materialized = await materializeServerExportMedia(snapshot, {
    publicDirectory: dir,
    uploadDirectory: dir,
    resolveUpload: (name) => (name === 'music.mp3' ? join(dir, name) : null),
    resolveUploadReference: () => null,
    hydrateUpload: async () => null,
    fetcher: async () => { throw new Error('the public fetcher must not see loopback URLs'); },
    loopbackFetcher: async (source) => {
      loopbackRequests.push(String(source));
      return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { 'content-type': 'image/png' } });
    },
  });
  const [music, comfy] = materialized.snapshot.timelines[0]!.items;
  assert.equal(music!.src, '/media/uploads/music.mp3', "the app's own upload URL renders as its local path");
  assert.deepEqual(loopbackRequests, ['http://127.0.0.1:8188/view?filename=out.png&type=output']);
  assert.match(comfy!.src, /^\/media\/uploads\/openchatcut-render-media-.+\.png$/, 'the local service result is materialized');
  assert.deepEqual([...await readFile(join(dir, comfy!.src.split('/').pop()!))], [137, 80, 78, 71]);
  await materialized.cleanup();

  // Loopback services are fetched only with the user's permission.
  resetCapabilityStateForTests();
  const asked: string[] = [];
  const unregister = registerCapabilityPrompter(async (request) => {
    asked.push(`${request.capability} ${request.scopeKey}`);
    return 'deny';
  });
  await assert.rejects(loopbackMediaFetch('http://127.0.0.1:8188/view?filename=a.png'), /denied/i);
  assert.deepEqual(asked, ['NETWORK_ACCESS network.loopback:127.0.0.1:8188']);
  await assert.rejects(loopbackMediaFetch('http://192.168.1.5:8188/view'), /not a loopback service URL/);
  unregister();
} finally {
  resetCapabilityStateForTests();
  await rm(dir, { recursive: true, force: true });
}
console.log('loopback-media.verify: app upload URLs map locally; local services need permission');
