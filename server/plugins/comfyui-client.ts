// ComfyUI generation provider: runs the user's own ComfyUI workflows (a local
// server at http://127.0.0.1:8188, or a tunnel to a rented GPU box) through
// ComfyUI's HTTP API: POST /prompt, poll GET /history/<id>, fetch GET /view.
//
// Workflows live in a folder chosen in settings (COMFYUI_WORKFLOW_DIR). Each
// workflow is an API-format export (<id>.json, "Save (API Format)" in ComfyUI)
// plus a manifest (<id>.manifest.json) that says which node inputs receive the
// prompt, seed, size, reference image and so on, and which node's output is
// the result:
//
//   {
//     "name": "LTX 2.5 image to video",
//     "kind": "video",                                  // or "image"
//     "inputs": {
//       "prompt":         { "node": "6",  "field": "text" },
//       "negativePrompt": { "node": "7",  "field": "text" },
//       "seed":           { "node": "3",  "field": "seed" },
//       "width":          { "node": "12", "field": "width" },
//       "height":         { "node": "12", "field": "height" },
//       "frames":         { "node": "12", "field": "length" },
//       "fps":            { "node": "40", "field": "frame_rate" },
//       "image":          { "node": "20", "field": "image" }
//     },
//     "output": { "node": "9" }
//   }
//
// Only "prompt" and "output" are required. The base URL comes from settings,
// never from a project or the agent, so it is not an SSRF vector.
import { randomInt, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

export type ComfyWorkflowKind = 'image' | 'video';
const INPUT_NAMES = ['prompt', 'negativePrompt', 'seed', 'width', 'height', 'frames', 'fps', 'image'] as const;
export type ComfyInputName = typeof INPUT_NAMES[number];

export interface ComfyInputTarget { readonly node: string; readonly field: string }

export interface ComfyWorkflowManifest {
  readonly id: string;
  readonly name: string;
  readonly kind: ComfyWorkflowKind;
  readonly inputs: Partial<Record<ComfyInputName, ComfyInputTarget>>;
  readonly output: { readonly node: string };
}

export interface ComfyConnection {
  readonly baseUrl: string;
  /** Optional bearer token for a protected tunnel. */
  readonly apiKey?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface ComfyRunValues {
  readonly prompt: string;
  readonly negativePrompt?: string;
  readonly seed?: number;
  readonly width?: number;
  readonly height?: number;
  readonly durationSeconds?: number;
  readonly fps?: number;
  /** Local path of a reference image, uploaded to ComfyUI before the run. */
  readonly imagePath?: string;
}

export interface ComfyOutputFile {
  readonly filename: string;
  readonly subfolder: string;
  readonly type: string;
}

const WORKFLOW_ID = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,119}$/;
const DEFAULT_POLL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 60 * 60_000;

function isTarget(value: unknown): value is ComfyInputTarget {
  const target = value as ComfyInputTarget | null;
  return Boolean(target && typeof target === 'object'
    && typeof target.node === 'string' && target.node
    && typeof target.field === 'string' && target.field);
}

/** Parse and check one manifest; throws with the reason it is unusable. */
export function parseComfyManifest(id: string, raw: unknown): ComfyWorkflowManifest {
  const manifest = raw as { name?: unknown; kind?: unknown; inputs?: Record<string, unknown>; output?: { node?: unknown } } | null;
  if (!manifest || typeof manifest !== 'object') throw new Error(`${id}: manifest must be a JSON object`);
  if (manifest.kind !== 'image' && manifest.kind !== 'video') throw new Error(`${id}: kind must be "image" or "video"`);
  const inputs: Partial<Record<ComfyInputName, ComfyInputTarget>> = {};
  for (const [name, target] of Object.entries(manifest.inputs ?? {})) {
    if (!(INPUT_NAMES as readonly string[]).includes(name)) throw new Error(`${id}: unknown input "${name}"`);
    if (!isTarget(target)) throw new Error(`${id}: input "${name}" needs { "node": "<id>", "field": "<name>" }`);
    inputs[name as ComfyInputName] = { node: target.node, field: target.field };
  }
  if (!inputs.prompt) throw new Error(`${id}: inputs.prompt is required`);
  if (typeof manifest.output?.node !== 'string' || !manifest.output.node) throw new Error(`${id}: output.node is required`);
  return {
    id,
    name: typeof manifest.name === 'string' && manifest.name.trim() ? manifest.name.trim() : id,
    kind: manifest.kind,
    inputs,
    output: { node: manifest.output.node },
  };
}

/** Workflows in the library folder that have a valid manifest, plus why others were skipped. */
export function listComfyWorkflows(dir: string): { workflows: ComfyWorkflowManifest[]; problems: string[] } {
  const workflows: ComfyWorkflowManifest[] = [];
  const problems: string[] = [];
  if (!dir || !existsSync(dir)) return { workflows, problems: dir ? [`workflow folder not found: ${dir}`] : [] };
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.manifest.json')) continue;
    const id = name.slice(0, -'.manifest.json'.length);
    try {
      if (!WORKFLOW_ID.test(id)) throw new Error(`${id}: use letters, digits, space, dot, dash or underscore in the file name`);
      if (!existsSync(join(dir, `${id}.json`))) throw new Error(`${id}: ${id}.json (the API-format workflow) is missing`);
      workflows.push(parseComfyManifest(id, JSON.parse(readFileSync(join(dir, name), 'utf8'))));
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { workflows, problems };
}

export function findComfyWorkflow(dir: string, id: string, kind: ComfyWorkflowKind): ComfyWorkflowManifest {
  const { workflows, problems } = listComfyWorkflows(dir);
  const candidates = workflows.filter((workflow) => workflow.kind === kind);
  const match = candidates.find((workflow) => workflow.id === id)
    ?? (id ? candidates.find((workflow) => workflow.name.toLowerCase() === id.toLowerCase()) : candidates.length === 1 ? candidates[0] : undefined);
  if (match) return match;
  const available = candidates.map((workflow) => `${workflow.id} (${workflow.name})`).join(', ') || 'none';
  const skipped = problems.length ? ` Skipped: ${problems.join('; ')}.` : '';
  throw new Error(id
    ? `ComfyUI ${kind} workflow "${id}" not found. Available: ${available}.${skipped}`
    : `Choose a ComfyUI ${kind} workflow (workflow argument). Available: ${available}.${skipped}`);
}

/** The API-format graph with the run's values written into the manifest's inputs. */
export function injectComfyValues(
  graph: Record<string, { inputs?: Record<string, unknown> }>,
  manifest: ComfyWorkflowManifest,
  values: ComfyRunValues & { uploadedImage?: string },
): Record<string, unknown> {
  const next = structuredClone(graph);
  const set = (name: ComfyInputName, value: unknown) => {
    const target = manifest.inputs[name];
    if (!target || value === undefined) return;
    const node = next[target.node];
    if (!node || typeof node !== 'object') throw new Error(`${manifest.id}: node ${target.node} (${name}) is not in the workflow`);
    node.inputs = { ...node.inputs, [target.field]: value };
  };
  if (!next[manifest.output.node]) throw new Error(`${manifest.id}: output node ${manifest.output.node} is not in the workflow`);
  set('prompt', values.prompt);
  set('negativePrompt', values.negativePrompt);
  set('seed', values.seed ?? randomInt(0, 2 ** 31));
  set('width', values.width);
  set('height', values.height);
  const fps = values.fps ?? 24;
  set('fps', manifest.inputs.fps ? fps : undefined);
  set('frames', values.durationSeconds ? Math.max(1, Math.round(values.durationSeconds * fps)) : undefined);
  if (values.imagePath && !manifest.inputs.image) throw new Error(`${manifest.id} does not take a reference image`);
  set('image', values.uploadedImage);
  return next;
}

function endpoint(connection: ComfyConnection, path: string): string {
  const base = connection.baseUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) throw new Error('ComfyUI address must start with http:// or https://');
  return `${base}${path}`;
}

async function request(connection: ComfyConnection, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (connection.apiKey?.trim()) headers.set('Authorization', `Bearer ${connection.apiKey.trim()}`);
  const response = await (connection.fetchImpl ?? fetch)(endpoint(connection, path), { ...init, headers, redirect: 'error' });
  if (!response.ok) {
    const text = (await response.text().catch(() => '')).slice(0, 500);
    throw new Error(`ComfyUI ${path.split('?')[0]} failed (HTTP ${response.status})${text ? `: ${text}` : ''}`);
  }
  return response;
}

async function uploadImage(connection: ComfyConnection, path: string): Promise<string> {
  const form = new FormData();
  form.append('image', new Blob([await readFile(path)]), `${randomUUID()}${extname(path) || '.png'}`);
  form.append('overwrite', 'true');
  const data = await (await request(connection, '/upload/image', { method: 'POST', body: form })).json() as { name?: unknown; subfolder?: unknown };
  if (typeof data.name !== 'string' || !data.name) throw new Error('ComfyUI did not accept the reference image');
  return typeof data.subfolder === 'string' && data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

/** Queue the workflow; returns ComfyUI's prompt id. */
export async function submitComfyWorkflow(
  connection: ComfyConnection,
  workflowDir: string,
  manifest: ComfyWorkflowManifest,
  values: ComfyRunValues,
): Promise<string> {
  const graph = JSON.parse(await readFile(join(workflowDir, `${manifest.id}.json`), 'utf8')) as Record<string, { inputs?: Record<string, unknown> }>;
  if (!graph || typeof graph !== 'object' || Array.isArray(graph) || 'nodes' in graph) {
    throw new Error(`${manifest.id}.json is not an API-format workflow; export it with "Save (API Format)" in ComfyUI`);
  }
  const uploadedImage = values.imagePath ? await uploadImage(connection, values.imagePath) : undefined;
  const prompt = injectComfyValues(graph, manifest, { ...values, uploadedImage });
  const data = await (await request(connection, '/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, client_id: `openchatcut-${randomUUID()}` }),
  })).json() as { prompt_id?: unknown; node_errors?: unknown; error?: unknown };
  if (typeof data.prompt_id !== 'string' || !data.prompt_id) {
    throw new Error(`ComfyUI rejected the workflow: ${JSON.stringify(data.error ?? data.node_errors ?? data).slice(0, 500)}`);
  }
  return data.prompt_id;
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')); }, { once: true });
});

/** Wait for the run to finish and return the output node's first file. */
export async function waitForComfyOutput(
  connection: ComfyConnection,
  promptId: string,
  manifest: ComfyWorkflowManifest,
  options: { pollMs?: number; timeoutMs?: number; signal?: AbortSignal; onProgress?: (seconds: number) => void } = {},
): Promise<ComfyOutputFile> {
  const started = Date.now();
  const deadline = started + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  for (;;) {
    options.signal?.throwIfAborted();
    const history = await (await request(connection, `/history/${encodeURIComponent(promptId)}`)).json() as Record<string, {
      status?: { status_str?: unknown; completed?: unknown; messages?: unknown };
      outputs?: Record<string, Record<string, Array<Partial<ComfyOutputFile>>>>;
    }>;
    const entry = history[promptId];
    if (entry?.status?.status_str === 'error') {
      const messages = JSON.stringify(entry.status.messages ?? '').slice(0, 600);
      throw new Error(`ComfyUI run ${promptId} failed: ${messages}`);
    }
    const output = entry?.outputs?.[manifest.output.node];
    if (output) {
      const files = [...(output.videos ?? []), ...(output.gifs ?? []), ...(output.images ?? [])]
        .filter((file) => typeof file.filename === 'string' && file.filename);
      const file = files.find((candidate) => candidate.type !== 'temp') ?? files[0];
      if (file) return { filename: file.filename!, subfolder: file.subfolder ?? '', type: file.type ?? 'output' };
    }
    // Finished, but nothing on the manifest's output node: a wrong node id or
    // an output node that saves nowhere. Fail now rather than poll for an hour.
    if (entry?.status?.completed === true) {
      const nodes = Object.keys(entry.outputs ?? {}).join(', ') || 'none';
      throw new Error(`ComfyUI run ${promptId} finished without a file on output node ${manifest.output.node} (nodes with output: ${nodes}); check output.node in ${manifest.id}.manifest.json`);
    }
    if (Date.now() > deadline) throw new Error(`ComfyUI run ${promptId} did not finish in time`);
    options.onProgress?.(Math.round((Date.now() - started) / 1000));
    await sleep(options.pollMs ?? DEFAULT_POLL_MS, options.signal);
  }
}

/** The /view URL of an output file. */
export function comfyViewUrl(connection: ComfyConnection, file: ComfyOutputFile): string {
  const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type });
  return endpoint(connection, `/view?${query}`);
}

/** Download an output file's bytes. */
export async function downloadComfyOutput(connection: ComfyConnection, file: ComfyOutputFile): Promise<{ bytes: Buffer; filename: string }> {
  const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type });
  const response = await request(connection, `/view?${query}`);
  return { bytes: Buffer.from(await response.arrayBuffer()), filename: basename(file.filename) };
}

/** A fetch for downloading ComfyUI results that carries the optional token. */
export function comfyFetch(connection: ComfyConnection): typeof fetch {
  return (input, init = {}) => {
    const headers = new Headers(init.headers);
    if (connection.apiKey?.trim()) headers.set('Authorization', `Bearer ${connection.apiKey.trim()}`);
    return (connection.fetchImpl ?? fetch)(input, { ...init, headers, redirect: 'error' });
  };
}
