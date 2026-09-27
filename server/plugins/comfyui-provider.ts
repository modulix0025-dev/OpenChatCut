// ComfyUI as an OpenChatCut generation provider: image generation (answered
// synchronously, like the other image providers) and video generation (a
// resumable generation job). The HTTP protocol and workflow library live in
// comfyui-client.ts.
import { spawn } from 'node:child_process';
import { rename, rm } from 'node:fs/promises';
import { getKey } from '../keystore.ts';
import { ffmpegBin } from '../media-binaries.ts';
import {
  downloadComfyOutput,
  findComfyWorkflow,
  submitComfyWorkflow,
  waitForComfyOutput,
  comfyViewUrl,
  type ComfyConnection,
  type ComfyRunValues,
} from './comfyui-client.ts';
import type { RegisterGenerationProviderTask } from './generation-job-types.ts';

export interface ComfySettings extends ComfyConnection {
  readonly workflowDir: string;
}

/** Settings from the keystore: COMFYUI_BASE_URL, COMFYUI_API_KEY, COMFYUI_WORKFLOW_DIR. */
export function comfySettings(fetchImpl?: typeof fetch): ComfySettings {
  return {
    baseUrl: getKey('COMFYUI_BASE_URL').trim(),
    apiKey: getKey('COMFYUI_API_KEY').trim() || undefined,
    workflowDir: getKey('COMFYUI_WORKFLOW_DIR').trim(),
    fetchImpl,
  };
}

function requireConfigured(settings: ComfySettings): void {
  if (!settings.baseUrl) throw new Error('ComfyUI is not configured. Set the ComfyUI address in Settings → AI visual → ComfyUI.');
  if (!settings.workflowDir) throw new Error('Choose the ComfyUI workflow folder in Settings → AI visual → ComfyUI.');
}

const PROVIDER_TASK_PREFIX = 'comfyui:';

/** Pixel size for an aspect ratio at a resolution, rounded to multiples of 16. */
export function comfyDimensions(ratio: string | undefined, resolution: string | undefined): { width: number; height: number } | null {
  const [w, h] = String(ratio ?? '').split(':').map(Number);
  if (!w || !h) return null;
  const short = Number(String(resolution ?? '720p').replace(/p$/i, '')) || (String(resolution).toLowerCase() === '4k' ? 2160 : 720);
  const round = (value: number) => Math.max(16, Math.round(value / 16) * 16);
  return w >= h
    ? { width: round((short * w) / h), height: round(short) }
    : { width: round(short), height: round((short * h) / w) };
}

/** Run an image workflow `count` times and return the images as base64. */
export async function generateComfyImages(
  values: ComfyRunValues & { workflow?: string; count: number },
  settings: ComfySettings = comfySettings(),
): Promise<Array<{ b64_json: string; width?: number; height?: number }>> {
  requireConfigured(settings);
  const manifest = findComfyWorkflow(settings.workflowDir, values.workflow ?? '', 'image');
  const images: Array<{ b64_json: string; width?: number; height?: number }> = [];
  for (let index = 0; index < values.count; index += 1) {
    const promptId = await submitComfyWorkflow(settings, settings.workflowDir, manifest, {
      ...values, seed: values.seed === undefined ? undefined : values.seed + index,
    });
    const file = await waitForComfyOutput(settings, promptId, manifest);
    const { bytes } = await downloadComfyOutput(settings, file);
    images.push({ b64_json: bytes.toString('base64'), width: values.width, height: values.height });
  }
  return images;
}

/** Submit (or, on resume, keep polling) a video workflow; returns the result's /view URL. */
export async function generateComfyVideo(
  values: ComfyRunValues & { workflow?: string },
  registerProviderTask: RegisterGenerationProviderTask,
  existingTaskId?: string,
  settings: ComfySettings = comfySettings(),
): Promise<string> {
  requireConfigured(settings);
  const manifest = findComfyWorkflow(settings.workflowDir, values.workflow ?? '', 'video');
  let promptId = existingTaskId?.startsWith(PROVIDER_TASK_PREFIX) ? existingTaskId.slice(PROVIDER_TASK_PREFIX.length) : '';
  if (!promptId) {
    promptId = await submitComfyWorkflow(settings, settings.workflowDir, manifest, values);
    await registerProviderTask('comfyui', `${PROVIDER_TASK_PREFIX}${promptId}`);
  }
  const file = await waitForComfyOutput(settings, promptId, manifest);
  return comfyViewUrl(settings, file);
}

/**
 * Drop container and stream metadata (the embedded workflow and prompt) from
 * a generated video, copying the streams unchanged. ComfyUI writes megabytes
 * of it into every render.
 */
export async function stripVideoMetadata(file: string): Promise<void> {
  const temporary = `${file}.clean.mp4`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegBin(), [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', file,
      '-map', '0', '-c', 'copy', '-map_metadata', '-1', '-map_metadata:s', '-1', '-movflags', '+faststart', temporary,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk}`.slice(-2000); });
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`metadata cleanup failed: ${stderr}`))));
  }).catch(async (error: unknown) => {
    await rm(temporary, { force: true });
    throw error;
  });
  await rename(temporary, file);
}
