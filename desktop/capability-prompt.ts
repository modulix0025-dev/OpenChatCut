// Native permission dialog for the capability broker (server/security/capabilities.ts).
//
// The dialog is drawn by the OS through Electron's main process, so page
// script — including a compromised renderer, agent tool output, or a
// malicious template — cannot render, pre-answer or click it. Deny is the
// default button and the cancel action (Esc / closing the dialog).
import { BrowserWindow, dialog, type MessageBoxOptions } from 'electron';
import type {
  Capability,
  CapabilityDecision,
  CapabilityPrompter,
  CapabilityRequest,
} from '../server/security/capabilities.ts';

const CAPABILITY_LABEL: Record<Capability, string> = {
  FILES_READ: 'Read files on this computer',
  FILES_WRITE: 'Write files on this computer',
  MEDIA_IMPORT: 'Import media',
  MEDIA_EXPORT: 'Export media',
  PROCESS_EXECUTION: 'Run a program',
  NETWORK_ACCESS: 'Connect to a network service',
  CREDENTIALS: 'Use your stored API keys',
  CLIPBOARD: 'Read the clipboard',
  MEDIA_CAPTURE: 'Use the microphone',
  SYSTEM_INTEGRATION: 'Change how OpenChatCut integrates with your system',
  MCP_TOOLS: 'Let an external agent act without asking',
};

const REQUESTER_LABEL: Record<string, string> = {
  editor: 'the editor',
  agent: 'the AI agent',
  'external-mcp': 'an external MCP client',
  renderer: 'the editor page',
  system: 'OpenChatCut',
};

export interface CapabilityDialogChoice {
  readonly label: string;
  readonly decision: CapabilityDecision;
}

/** Buttons for a request, Deny always first (the default and cancel id). */
export function capabilityDialogChoices(request: CapabilityRequest): CapabilityDialogChoice[] {
  const choices: CapabilityDialogChoice[] = [
    { label: 'Deny', decision: 'deny' },
    { label: 'Allow once', decision: 'allow-once' },
  ];
  if (request.rememberable === false) return choices;
  choices.push({ label: 'Allow for this session', decision: 'allow-session' });
  if (request.projectId) choices.push({ label: 'Allow for this project', decision: 'allow-project' });
  choices.push({ label: 'Always allow', decision: 'allow-always' });
  return choices;
}

export function capabilityDialogOptions(request: CapabilityRequest): MessageBoxOptions {
  const choices = capabilityDialogChoices(request);
  const who = REQUESTER_LABEL[request.requester ?? 'system'] ?? 'OpenChatCut';
  const lines = [
    `Permission: ${CAPABILITY_LABEL[request.capability]}`,
    `Requested by: ${who}`,
  ];
  if (request.detail) lines.push('', request.detail.length > 1500 ? `${request.detail.slice(0, 1500)}…` : request.detail);
  lines.push('', 'Only allow this if you started the action and trust it.');
  return {
    type: 'warning',
    title: 'OpenChatCut permission request',
    message: `OpenChatCut wants to: ${request.summary}`,
    detail: lines.join('\n'),
    buttons: choices.map((choice) => choice.label),
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

export function createNativeCapabilityPrompter(
  parentWindow: () => BrowserWindow | null,
): CapabilityPrompter {
  return async (request) => {
    const options = capabilityDialogOptions(request);
    const choices = capabilityDialogChoices(request);
    const parent = parentWindow();
    const result = parent && !parent.isDestroyed()
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
    return choices[result.response]?.decision ?? 'deny';
  };
}
