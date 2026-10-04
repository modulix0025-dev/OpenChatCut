import type { IncomingMessage, ServerResponse } from 'node:http';
import { TLSSocket } from 'node:tls';
import type { Plugin } from 'vite';
import type {
  ClaudeCodeAccountSummary,
  ClaudeCodeAgentModelsResponse,
  ClaudeCodeAgentStatus,
  ClaudeCodeConnectionTestResult,
  ClaudeCodeLoginState,
  ClaudeCodeTurnRequest,
  ClaudeCodeTurnStreamEvent,
} from '../../shared/claude-code-agent.ts';
import { externalMcpToken } from '../editor-auth.ts';
import {
  inspectClaudeCodeInstallation,
  MINIMUM_CLAUDE_CODE_VERSION,
  type ClaudeCodeInstallation,
} from '../claude-code/installation.ts';
import { runClaudeCodeTurn } from '../claude-code/turn-runner.ts';
import { claudeCodeModelList } from '../claude-code/models.ts';
import { claudeCodeChildEnvironment, claudeCodeEnvOverrides } from '../claude-code/environment.ts';
import {
  ClaudeCodeLoginError,
  ClaudeCodeLoginManager,
  logoutClaudeCode,
  validAccountType,
  validLoginEmail,
} from '../claude-code/login.ts';
import { testClaudeCodeConnection } from '../claude-code/connection-test.ts';
import { getKey } from '../keystore.ts';

const JSON_BODY_LIMIT = 4 * 1024 * 1024;
// A cold start of the npm (node) CLI on Windows routinely takes several
// seconds; 8 s made a healthy install read as "could not read sign-in status".
const AUTH_STATUS_TIMEOUT_MS = 25_000;

const loginManager = new ClaudeCodeLoginManager();

// Canonical model ids, not the CLI's short aliases ("sonnet"/"opus"/"haiku").
// The CLI accepts both and resolves an alias to exactly these ids (a `--model
// sonnet` turn reports `claude-sonnet-5` back in modelUsage), but the shared
// capability catalog is keyed by canonical id: aliases miss every entry and
// fall through to the estimator, which reports a wrong context window and
// claims tools/images are unsupported. The list comes from that catalog plus
// CLAUDE_CODE_EXTRA_MODELS (see server/claude-code/models.ts).

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    req.resume();
    reject(new HttpError(413, 'request body too large'));
    return promise;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  const cleanup = () => {
    req.off('data', onData);
    req.off('end', onEnd);
    req.off('error', onError);
    req.off('aborted', onAborted);
  };
  const fail = (error: Error) => { cleanup(); req.resume(); reject(error); };
  const onData = (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {
      fail(new HttpError(413, 'request body too large'));
      return;
    }
    chunks.push(buffer);
  };
  const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks)); };
  const onError = () => fail(new HttpError(400, 'invalid request body'));
  const onAborted = () => fail(new HttpError(400, 'request body aborted'));
  req.on('data', onData);
  req.once('end', onEnd);
  req.once('error', onError);
  req.once('aborted', onAborted);
  return promise;
}

async function readJson(req: IncomingMessage, limit = JSON_BODY_LIMIT): Promise<Record<string, unknown>> {
  const buffer = await readBody(req, limit);
  let value: unknown;
  try {
    value = JSON.parse(buffer.toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'body must be valid JSON');
  }
  const shaped = object(value);
  if (!shaped) throw new HttpError(400, 'body must be a JSON object');
  return shaped;
}

function shortString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value || value.length > maxLength) {
    throw new HttpError(400, `${field} is invalid`);
  }
  return value;
}

function unsupportedMessage(): string {
  return `Claude Code CLI ${MINIMUM_CLAUDE_CODE_VERSION} or newer is required. Update Claude Code and try again.`;
}

function unavailableMessage(installation: ClaudeCodeInstallation): string {
  if (!installation.installed) return 'Claude Code CLI is not installed.';
  if (!installation.supported) return unsupportedMessage();
  return 'Claude Code CLI is unavailable.';
}

function accountSummary(value: Record<string, unknown>): ClaudeCodeAccountSummary {
  return {
    loggedIn: value.loggedIn === true,
    email: typeof value.email === 'string' ? value.email : null,
    subscriptionType: typeof value.subscriptionType === 'string' ? value.subscriptionType : null,
    authMethod: typeof value.authMethod === 'string' ? value.authMethod : null,
    orgName: typeof value.orgName === 'string' ? value.orgName : null,
    apiProvider: typeof value.apiProvider === 'string' ? value.apiProvider : null,
  };
}

type AuthStatusResult =
  | { readonly account: ClaudeCodeAccountSummary; readonly error?: undefined }
  | { readonly account: null; readonly error: string };

async function readAuthStatus(claudePath: string): Promise<AuthStatusResult> {
  const { execFile } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const { claudeCodeCommand } = await import('../claude-code/command.ts');
  const command = claudeCodeCommand(claudePath, ['auth', 'status', '--json']);
  const { promise, resolve } = Promise.withResolvers<AuthStatusResult>();
  execFile(command.executable, command.args, {
    encoding: 'utf8',
    // Same environment as the turn: what this reports is what a turn will use.
    env: claudeCodeChildEnvironment(),
    cwd: tmpdir(),
    timeout: AUTH_STATUS_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
    windowsHide: true,
    windowsVerbatimArguments: command.windowsVerbatimArguments,
  }, (error, stdout, stderr) => {
    // `auth status` exits non-zero when signed out but still prints the JSON.
    try {
      const parsed = object(JSON.parse(stdout));
      if (parsed) { resolve({ account: accountSummary(parsed) }); return; }
    } catch {
      // fall through to the error below
    }
    const killed = error && (error as { killed?: boolean }).killed;
    const detail = `${stderr}\n${stdout}`.trim().split(/\r?\n/).filter(Boolean).at(-1)?.slice(0, 300);
    resolve({
      account: null,
      error: killed
        ? `Claude Code did not answer within ${AUTH_STATUS_TIMEOUT_MS / 1000} s (claude auth status).`
        : `Could not read Claude Code sign-in status${detail ? `: ${detail}` : '.'}`,
    });
  });
  return promise;
}

async function claudeCodeStatus(): Promise<ClaudeCodeAgentStatus> {
  const extras = { login: loginManager.current(), envOverrides: claudeCodeEnvOverrides() };
  const installation = await inspectClaudeCodeInstallation();
  if (!installation.installed) return { installed: false, version: null, account: null, path: null, ...extras };
  if (!installation.supported || !installation.path) {
    return {
      installed: true, version: installation.version, account: null, path: installation.path,
      error: unsupportedMessage(), ...extras,
    };
  }
  const status = await readAuthStatus(installation.path);
  return {
    installed: true,
    version: installation.version,
    account: status.account,
    path: installation.path,
    ...(status.error ? { error: status.error } : {}),
    ...extras,
  };
}

async function requireClaudeCodePath(): Promise<string> {
  const installation = await inspectClaudeCodeInstallation();
  if (!installation.path || !installation.supported) throw new HttpError(503, unavailableMessage(installation));
  return installation.path;
}

async function startLogin(body: Record<string, unknown>): Promise<ClaudeCodeLoginState> {
  const accountType = validAccountType(body.accountType);
  const email = validLoginEmail(body.email);
  const sso = body.sso === true;
  return loginManager.start(await requireClaudeCodePath(), { accountType, ...(email ? { email } : {}), sso });
}

async function logout(): Promise<void> {
  loginManager.cancel();
  await logoutClaudeCode(await requireClaudeCodePath());
}

async function testConnection(body: Record<string, unknown>): Promise<ClaudeCodeConnectionTestResult> {
  const model = typeof body.model === 'string' && body.model ? cliToken(body.model, 'model') : undefined;
  return testClaudeCodeConnection(await requireClaudeCodePath(), model);
}

function claudeCodeModels(): ClaudeCodeAgentModelsResponse {
  return { models: claudeCodeModelList(getKey('CLAUDE_CODE_EXTRA_MODELS')) };
}

/** A CLI argument value that cannot be parsed as an option. */
export function cliToken(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@[\]/-]{0,127}$/.test(value)) throw new Error(`invalid ${field}`);
  return value;
}

function parseClaudeCodeTurnRequest(body: Record<string, unknown>): ClaudeCodeTurnRequest {
  return {
    requestId: shortString(body.requestId, 'requestId', 128),
    system: typeof body.system === 'string' ? body.system.slice(0, 1024 * 1024) : '',
    prompt: shortString(body.prompt, 'prompt', 2 * 1024 * 1024),
    projectId: shortString(body.projectId, 'projectId', 256),
    // Both become CLI argument values; a value starting with "-" would be read
    // by the Claude CLI as another option (e.g. --settings with hooks).
    ...(typeof body.model === 'string' && body.model ? { model: cliToken(body.model, 'model') } : {}),
    ...(typeof body.sessionId === 'string' && body.sessionId ? { sessionId: cliToken(body.sessionId, 'sessionId') } : {}),
    ...(body.approvalMode === 'auto' || body.approvalMode === 'manual'
      ? { approvalMode: body.approvalMode } : {}),
  };
}

function ndjsonWriter(res: ServerResponse): (event: ClaudeCodeTurnStreamEvent) => void {
  let terminal = false;
  return (event) => {
    if (terminal) return;
    if (event.type === 'done' || event.type === 'error') terminal = true;
    if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
  };
}

function selfMcpUrl(req: IncomingMessage): string {
  const host = req.headers.host;
  if (!host || /[/\\@?#,\s]/.test(host)) throw new HttpError(400, 'invalid host header');
  const protocol = req.socket instanceof TLSSocket ? 'https' : 'http';
  return `${protocol}://${host}/api/external-mcp/mcp`;
}

/**
 * The Vite dev/embedded HTTP server this plugin is mounted on, captured so
 * in-process callers (no incoming request to read a Host header from) can
 * still reach this instance's own /api/external-mcp/mcp over loopback HTTP.
 */
let boundHttpServer: import('vite').ViteDevServer['httpServer'] = null;

function resolveSelfMcpUrl(): string {
  const address = boundHttpServer?.address();
  if (!address || typeof address === 'string') return 'http://127.0.0.1:5199/api/external-mcp/mcp';
  const isIPv6 = address.family === 'IPv6';
  const host = isIPv6
    ? `[${address.address === '::' ? '::1' : address.address}]`
    : (address.address === '0.0.0.0' ? '127.0.0.1' : address.address);
  return `http://${host}:${address.port}/api/external-mcp/mcp`;
}

async function streamTurn(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>): Promise<void> {
  const request = parseClaudeCodeTurnRequest(body);
  const installation = await inspectClaudeCodeInstallation();
  if (!installation.path || !installation.supported) throw new HttpError(503, unavailableMessage(installation));
  const mcpUrl = selfMcpUrl(req);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const emit = ndjsonWriter(res);
  const controller = new AbortController();
  let finished = false;
  const disconnect = () => { if (!finished) controller.abort(new Error('HTTP client disconnected.')); };
  req.once('aborted', disconnect);
  res.once('close', disconnect);
  if (req.aborted || res.destroyed) disconnect();
  try {
    await runClaudeCodeTurn(installation.path, request, mcpUrl, externalMcpToken(), emit, controller.signal);
  } catch {
    emit({ type: 'error', message: 'Claude Code could not run this turn.' });
    emit({ type: 'done' });
  } finally {
    finished = true;
    req.off('aborted', disconnect);
    res.off('close', disconnect);
    if (!res.destroyed && !res.writableEnded) res.end();
  }
}

function routePath(req: IncomingMessage): string {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  return pathname.startsWith('/api/claude-code') ? pathname.slice('/api/claude-code'.length) || '/' : pathname;
}

async function handleClaudeCodeRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = routePath(req);
  if (path === '/status' && req.method === 'GET') return sendJson(res, 200, await claudeCodeStatus());
  if (path === '/models' && req.method === 'GET') return sendJson(res, 200, claudeCodeModels());
  if (path === '/turn' && req.method === 'POST') return streamTurn(req, res, await readJson(req));
  if (path === '/login/start' && req.method === 'POST') return sendJson(res, 200, await startLogin(await readJson(req)));
  if (path === '/login/code' && req.method === 'POST') {
    const body = await readJson(req);
    return sendJson(res, 200, loginManager.submitCode(
      shortString(body.loginId, 'loginId', 128),
      shortString(body.code, 'code', 2048),
    ));
  }
  if (path === '/login/cancel' && req.method === 'POST') {
    const body = await readJson(req);
    loginManager.cancel(typeof body.loginId === 'string' ? body.loginId : undefined);
    return sendJson(res, 200, { ok: true });
  }
  if (path === '/logout' && req.method === 'POST') {
    await readJson(req);
    await logout();
    return sendJson(res, 200, { ok: true });
  }
  if (path === '/test' && req.method === 'POST') return sendJson(res, 200, await testConnection(await readJson(req)));
  const known = ['/status', '/models', '/turn', '/login/start', '/login/code', '/login/cancel', '/logout', '/test'];
  if (known.includes(path)) throw new HttpError(405, 'method not allowed');
  throw new HttpError(404, 'not found');
}

function handleFailure(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    if (!res.writableEnded && !res.destroyed) res.end();
    return;
  }
  if (error instanceof HttpError || error instanceof ClaudeCodeLoginError) sendJson(res, error.status, { error: error.message });
  else if (error instanceof Error && /^invalid (model|sessionId)$/.test(error.message)) sendJson(res, 400, { error: error.message });
  else sendJson(res, 500, { error: 'Claude Code request failed.' });
}

export function claudeCodeAgentPlugin(): Plugin {
  return {
    name: 'openchatcut-claude-code-agent',
    configureServer(server) {
      boundHttpServer = server.httpServer ?? null;
      server.middlewares.use('/api/claude-code', (req, res) => {
        void handleClaudeCodeRequest(req, res).catch((error) => handleFailure(res, error));
      });
    },
  };
}

/**
 * Internal server-side entry for the Agent run executor: runs one Claude
 * Code turn directly, without an HTTP round trip for the caller — the
 * subprocess itself still talks to /api/external-mcp/mcp over loopback HTTP,
 * since that's Claude Code CLI's only tool-calling mechanism (MCP).
 */
export async function runServerClaudeCodeTurn(
  request: ClaudeCodeTurnRequest,
  emit: (event: ClaudeCodeTurnStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const installation = await inspectClaudeCodeInstallation();
  if (!installation.path || !installation.supported) throw new HttpError(503, unavailableMessage(installation));
  await runClaudeCodeTurn(installation.path, request, resolveSelfMcpUrl(), externalMcpToken(), emit, signal);
}
