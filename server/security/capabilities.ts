// Central capability broker: the single authorization point for privileged
// actions that the renderer, the in-app agent, external MCP clients or imported
// content can trigger. Default state is DENY.
//
// A privileged code path calls requireCapability() with a description of what
// it is about to do. The broker answers from existing grants, or asks the
// registered prompter. The desktop app registers a native Electron dialog
// (desktop/capability-prompt.ts), which renderer or agent code cannot draw,
// click or dismiss on the user's behalf. With no prompter registered, every
// request is denied. The Vite dev server registers an explicit
// development policy instead (config/vite.config.ts).
//
// Grants are scoped by `scopeKey`: one binary in one skill, one directory, one
// external client, never a whole capability class. "Always" and per-project
// grants persist in <security dir>/capability-grants.json (0600); session
// grants live in memory only.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { audit } from './audit-log.ts';

export const CAPABILITIES = [
  'FILES_READ',
  'FILES_WRITE',
  'MEDIA_IMPORT',
  'MEDIA_EXPORT',
  'PROCESS_EXECUTION',
  'NETWORK_ACCESS',
  'CREDENTIALS',
  'CLIPBOARD',
  'MEDIA_CAPTURE',
  'SYSTEM_INTEGRATION',
  'MCP_TOOLS',
] as const;
export type Capability = typeof CAPABILITIES[number];

export type CapabilityRequester = 'editor' | 'agent' | 'external-mcp' | 'renderer' | 'system';

export interface CapabilityRequest {
  readonly capability: Capability;
  /** Stable machine id for the action, e.g. `skill.exec`. */
  readonly action: string;
  /** One sentence shown to the user: what OpenChatCut wants to do. */
  readonly summary: string;
  /** Exact target (command line, directory, host) shown verbatim. */
  readonly detail?: string;
  /** What a remembered grant covers. Narrow: include the concrete target. */
  readonly scopeKey: string;
  readonly requester?: CapabilityRequester;
  readonly projectId?: string;
  /** False for actions that must be confirmed every time (no remember options). */
  readonly rememberable?: boolean;
}

export type CapabilityDecision = 'deny' | 'allow-once' | 'allow-session' | 'allow-project' | 'allow-always';

export type CapabilityPrompter = (request: CapabilityRequest) => Promise<CapabilityDecision>;

export class CapabilityDeniedError extends Error {
  readonly capability: Capability;
  readonly action: string;
  readonly status = 403;
  constructor(request: CapabilityRequest, why = 'denied') {
    super(`Permission ${why}: ${request.summary}`);
    this.name = 'CapabilityDeniedError';
    this.capability = request.capability;
    this.action = request.action;
  }
}

export const SECURITY_DIR_ENV = 'OPENCHATCUT_SECURITY_DIR';

interface PersistedGrant {
  capability: Capability;
  scopeKey: string;
  projectId?: string;
  grantedAt: string;
}

let prompter: CapabilityPrompter | null = null;
const sessionGrants = new Set<string>();
let persisted: PersistedGrant[] | null = null;
// A denial is remembered briefly so a looping agent cannot flood the user
// with the same dialog until they click the wrong button.
const recentDenials = new Map<string, number>();
const DENIAL_COOLDOWN_MS = 30_000;
// Prompts are serialized: one native dialog at a time.
let promptChain: Promise<unknown> = Promise.resolve();

function grantKey(capability: Capability, scopeKey: string, projectId?: string): string {
  return `${capability}\u0000${scopeKey}\u0000${projectId ?? ''}`;
}

export function securityDir(): string {
  return process.env[SECURITY_DIR_ENV]?.trim() || join(homedir(), '.openchatcut', 'security');
}

function grantsFile(): string {
  return join(securityDir(), 'capability-grants.json');
}

function loadPersisted(): PersistedGrant[] {
  if (persisted) return persisted;
  try {
    const parsed = JSON.parse(readFileSync(grantsFile(), 'utf8')) as { grants?: unknown };
    persisted = Array.isArray(parsed.grants)
      ? parsed.grants.filter((grant): grant is PersistedGrant => Boolean(
        grant && typeof grant === 'object'
        && CAPABILITIES.includes((grant as PersistedGrant).capability)
        && typeof (grant as PersistedGrant).scopeKey === 'string',
      ))
      : [];
  } catch {
    persisted = [];
  }
  return persisted;
}

function savePersisted(grants: PersistedGrant[]): void {
  persisted = grants;
  try {
    mkdirSync(securityDir(), { recursive: true, mode: 0o700 });
    const file = grantsFile();
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ version: 1, grants }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, file);
  } catch (error) {
    console.warn('[security] could not persist capability grant:', error instanceof Error ? error.message : error);
  }
}

function hasGrant(request: CapabilityRequest): boolean {
  if (sessionGrants.has(grantKey(request.capability, request.scopeKey))) return true;
  if (request.projectId && sessionGrants.has(grantKey(request.capability, request.scopeKey, request.projectId))) return true;
  return loadPersisted().some((grant) => grant.capability === request.capability
    && grant.scopeKey === request.scopeKey
    && (grant.projectId === undefined || grant.projectId === request.projectId));
}

function record(request: CapabilityRequest, decision: CapabilityDecision | 'deny-no-prompter' | 'deny-cooldown' | 'granted-existing'): void {
  audit({
    event: decision.startsWith('deny') ? 'capability.denied' : 'capability.granted',
    capability: request.capability,
    action: request.action,
    requester: request.requester,
    decision,
    target: request.detail,
  });
}

/** Register the UI that asks the user. Returns a function that unregisters it. */
export function registerCapabilityPrompter(next: CapabilityPrompter): () => void {
  prompter = next;
  return () => {
    if (prompter === next) prompter = null;
  };
}

export function hasCapabilityPrompter(): boolean {
  return prompter !== null;
}

/**
 * Resolve when `request` is authorized; throw CapabilityDeniedError otherwise.
 * Every privileged action must call this; there is no bypass.
 */
export async function requireCapability(request: CapabilityRequest): Promise<void> {
  if (hasGrant(request)) {
    record(request, 'granted-existing');
    return;
  }
  const denialKey = grantKey(request.capability, request.scopeKey, request.projectId);
  const deniedAt = recentDenials.get(denialKey);
  if (deniedAt !== undefined && Date.now() - deniedAt < DENIAL_COOLDOWN_MS) {
    record(request, 'deny-cooldown');
    throw new CapabilityDeniedError(request);
  }
  const ask = prompter;
  if (!ask) {
    record(request, 'deny-no-prompter');
    throw new CapabilityDeniedError(request, 'denied (no permission prompt is available in this runtime)');
  }
  const decision = await (promptChain = promptChain.then(
    () => (hasGrant(request) ? 'allow-once' as const : ask(request)),
    () => (hasGrant(request) ? 'allow-once' as const : ask(request)),
  )) as CapabilityDecision;
  const rememberable = request.rememberable !== false;
  switch (decision) {
    case 'allow-once':
      break;
    case 'allow-session':
      if (rememberable) sessionGrants.add(grantKey(request.capability, request.scopeKey));
      break;
    case 'allow-project':
      if (rememberable && request.projectId) {
        savePersisted([...loadPersisted(), {
          capability: request.capability,
          scopeKey: request.scopeKey,
          projectId: request.projectId,
          grantedAt: new Date().toISOString(),
        }]);
      }
      break;
    case 'allow-always':
      if (rememberable) {
        savePersisted([...loadPersisted(), {
          capability: request.capability,
          scopeKey: request.scopeKey,
          grantedAt: new Date().toISOString(),
        }]);
      }
      break;
    default:
      recentDenials.set(denialKey, Date.now());
      record(request, 'deny');
      throw new CapabilityDeniedError(request);
  }
  record(request, decision);
}

/** Forget every persisted and session grant (Settings → reset permissions). */
export function revokeAllCapabilityGrants(): void {
  sessionGrants.clear();
  recentDenials.clear();
  savePersisted([]);
}

export function listPersistedCapabilityGrants(): readonly PersistedGrant[] {
  return [...loadPersisted()];
}

/** Tests only: drop in-memory state and re-read grants from disk. */
export function resetCapabilityStateForTests(): void {
  sessionGrants.clear();
  recentDenials.clear();
  persisted = null;
  prompter = null;
  promptChain = Promise.resolve();
}

/** HTTP helper: reply 403 with a JSON body when `error` is a denial. */
export function isCapabilityDenied(error: unknown): error is CapabilityDeniedError {
  return error instanceof CapabilityDeniedError;
}

export const CAPABILITY_POLICY_ENV = 'OPENCHATCUT_CAPABILITY_POLICY';

/**
 * Policy for the source-checkout dev server (`npm run dev`), which has no
 * native dialog. Developers running from source get the previous behavior
 * (allow, but every decision is written to the audit log and the console);
 * OPENCHATCUT_CAPABILITY_POLICY=deny makes the dev server default-deny like a
 * desktop user who clicks Deny. Never registered by the packaged app.
 */
export function developmentCapabilityPrompter(
  log: (message: string) => void = (message) => console.warn(message),
): CapabilityPrompter {
  const deny = process.env[CAPABILITY_POLICY_ENV]?.trim().toLowerCase() === 'deny';
  return async (request) => {
    log(`[security] dev server ${deny ? 'DENIED' : 'allowed'} ${request.capability} ${request.action}: ${request.summary}`);
    return deny ? 'deny' : 'allow-once';
  };
}
