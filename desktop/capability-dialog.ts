// Pure parts of the native permission dialog (no Electron runtime imports, so
// they can be verified in plain Node): button set and the text shown.
import type { MessageBoxOptions } from 'electron';
import {
  displaySafeText,
  type Capability,
  type CapabilityDecision,
  type CapabilityRequest,
} from '../server/security/capabilities.ts';

const DETAIL_LIMIT = 1500;

/** Detail lines with controls/bidi overrides removed; long text keeps head AND tail. */
export function capabilityDialogDetail(detail: string): { text: string; elided: boolean } {
  const lines = detail.split('\n').map((line) => displaySafeText(line, 100_000));
  const text = lines.join('\n');
  if (text.length <= DETAIL_LIMIT) return { text, elided: false };
  const half = Math.floor(DETAIL_LIMIT / 2);
  return {
    text: `${text.slice(0, half)}\n… [${text.length - 2 * half} characters not shown] …\n${text.slice(-half)}`,
    elided: true,
  };
}

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
  // Nothing is remembered for a request whose full detail cannot be shown.
  if (request.rememberable === false || (request.detail && capabilityDialogDetail(request.detail).elided)) return choices;
  choices.push({ label: 'Allow for this session', decision: 'allow-session' });
  if (request.maxRemember === 'session') return choices;
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
  if (request.detail) lines.push('', capabilityDialogDetail(request.detail).text);
  lines.push('', 'Only allow this if you started the action and trust it.');
  return {
    type: 'warning',
    title: 'OpenChatCut permission request',
    message: `OpenChatCut wants to: ${displaySafeText(request.summary, 300)}`,
    detail: lines.join('\n'),
    buttons: choices.map((choice) => choice.label),
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}
