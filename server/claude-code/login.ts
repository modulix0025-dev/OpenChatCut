import { randomUUID } from 'node:crypto';
import { execFile, spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import type {
  ClaudeCodeLoginAccountType,
  ClaudeCodeLoginState,
} from '../../shared/claude-code-agent.ts';
import { claudeCodeCommand } from './command.ts';
import { claudeCodeChildEnvironment } from './environment.ts';

/**
 * In-app sign-in for Claude Code. It drives the official `claude auth login`
 * — the CLI opens the Claude authorization page in the browser, receives the
 * result and writes its own credentials, exactly as it does from a terminal.
 * OpenChatCut never sees or stores a token: it only relays the authorization
 * link (as a fallback when the browser did not open) and, if the page shows a
 * code, passes that code to the CLI on stdin.
 */

export const CLAUDE_CODE_LOGIN_TIMEOUT_MS = 10 * 60_000;
const URL_WAIT_MS = 15_000;
const LOGOUT_TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT = 16 * 1024;
const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const CODE_PATTERN = /^[A-Za-z0-9._~#+/=-]{6,2048}$/;
// The CLI prints ANSI colour codes on some terminals; strip them before parsing.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
const URL_PATTERN = /https:\/\/[^\s"'<>`]+/g;
const AUTH_HOSTS = ['claude.ai', 'claude.com', 'anthropic.com'];

export class ClaudeCodeLoginError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ClaudeCodeLoginError';
    this.status = status;
  }
}

export interface ClaudeCodeLoginOptions {
  readonly accountType: ClaudeCodeLoginAccountType;
  readonly email?: string;
  readonly sso?: boolean;
}

export function validLoginEmail(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !EMAIL_PATTERN.test(value.trim())) {
    throw new ClaudeCodeLoginError(400, 'email is invalid');
  }
  return value.trim();
}

export function validAccountType(value: unknown): ClaudeCodeLoginAccountType {
  if (value === undefined || value === 'claudeai') return 'claudeai';
  if (value === 'console') return 'console';
  throw new ClaudeCodeLoginError(400, 'accountType is invalid');
}

/** An https link on a Claude / Anthropic host, or null. */
export function officialAuthUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.replace(/[).,;\]]+$/, ''));
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  return AUTH_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`)) ? url.toString() : null;
}

export function loginArgs(options: ClaudeCodeLoginOptions): string[] {
  const args = ['auth', 'login', options.accountType === 'console' ? '--console' : '--claudeai'];
  if (options.email) args.push('--email', options.email);
  if (options.sso) args.push('--sso');
  return args;
}

/** Last meaningful line of CLI output, for an error message. */
function failureText(output: string, exitCode: number | null): string {
  const lines = output.replace(ANSI_PATTERN, '').split(/\r?\n/)
    .map((line) => line.replace(/Paste code here if prompted\s*>?/i, '').trim())
    .filter((line) => line && !/https:\/\//.test(line) && !/opening browser/i.test(line));
  const last = lines.at(-1);
  return (last ? last.slice(0, 400) : '') || `Claude Code sign-in exited with code ${exitCode ?? 'unknown'}.`;
}

type SpawnLike = (executable: string, args: readonly string[], options: Parameters<typeof nodeSpawn>[2]) => ChildProcess;

export interface ClaudeCodeLoginManagerOptions {
  readonly spawn?: SpawnLike;
  readonly timeoutMs?: number;
  readonly urlWaitMs?: number;
  readonly platform?: NodeJS.Platform;
}

interface ActiveLogin {
  state: ClaudeCodeLoginState;
  readonly child: ChildProcess;
  readonly timer: NodeJS.Timeout;
  output: string;
  readonly urlWaiters: Array<() => void>;
}

export class ClaudeCodeLoginManager {
  private active: ActiveLogin | null = null;
  private last: ClaudeCodeLoginState | null = null;
  private readonly spawnProcess: SpawnLike;
  private readonly timeoutMs: number;
  private readonly urlWaitMs: number;
  private readonly platform: NodeJS.Platform;

  constructor(options: ClaudeCodeLoginManagerOptions = {}) {
    this.spawnProcess = options.spawn ?? ((executable, args, spawnOptions) => nodeSpawn(executable, args, spawnOptions));
    this.timeoutMs = options.timeoutMs ?? CLAUDE_CODE_LOGIN_TIMEOUT_MS;
    this.urlWaitMs = options.urlWaitMs ?? URL_WAIT_MS;
    this.platform = options.platform ?? process.platform;
  }

  /** The running sign-in, or the outcome of the last one. */
  current(): ClaudeCodeLoginState | null {
    return this.active?.state ?? this.last;
  }

  get pending(): boolean {
    return this.active !== null;
  }

  async start(claudePath: string, options: ClaudeCodeLoginOptions): Promise<ClaudeCodeLoginState> {
    // One sign-in at a time: a new request replaces the old one (e.g. the user
    // picked another account), so no stale CLI keeps a callback port open.
    this.cancel();
    const command = claudeCodeCommand(claudePath, loginArgs(options), this.platform);
    const child = this.spawnProcess(command.executable, command.args, {
      env: claudeCodeChildEnvironment(),
      cwd: tmpdir(),
      windowsHide: true,
      windowsVerbatimArguments: command.windowsVerbatimArguments,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const state: ClaudeCodeLoginState = {
      id: randomUUID(),
      status: 'starting',
      accountType: options.accountType,
      email: options.email ?? null,
      authUrl: null,
      codePrompt: false,
      error: null,
      startedAt: Date.now(),
    };
    const login: ActiveLogin = {
      state,
      child,
      output: '',
      urlWaiters: [],
      timer: setTimeout(() => this.finish(login, 'failed', 'Claude sign-in timed out. Start it again.'), this.timeoutMs),
    };
    this.active = login;
    const onOutput = (chunk: Buffer | string) => {
      login.output = (login.output + chunk.toString()).slice(-OUTPUT_LIMIT);
      this.parseOutput(login);
    };
    child.stdout?.on('data', onOutput);
    child.stderr?.on('data', onOutput);
    child.stdin?.on('error', () => {});
    child.once('error', (error) => this.finish(login, 'failed', `Could not start Claude Code: ${error.message}`));
    child.once('exit', (code) => {
      if (code === 0) this.finish(login, 'succeeded', null);
      else this.finish(login, 'failed', failureText(login.output, code));
    });
    await this.waitForUrl(login);
    return { ...login.state };
  }

  submitCode(id: string, code: string): ClaudeCodeLoginState {
    const login = this.active;
    if (!login || login.state.id !== id) throw new ClaudeCodeLoginError(409, 'No Claude sign-in is waiting for a code.');
    const trimmed = code.trim();
    if (!CODE_PATTERN.test(trimmed)) throw new ClaudeCodeLoginError(400, 'The authorization code is invalid.');
    if (!login.child.stdin || login.child.stdin.destroyed) {
      throw new ClaudeCodeLoginError(409, 'Claude Code is no longer accepting a code. Start the sign-in again.');
    }
    login.child.stdin.write(`${trimmed}\n`);
    login.state = { ...login.state, status: 'code-submitted', error: null };
    return { ...login.state };
  }

  /** Cancels the running sign-in (all of it when id is omitted). */
  cancel(id?: string): void {
    const login = this.active;
    if (!login || (id && login.state.id !== id)) return;
    this.finish(login, 'cancelled', null);
  }

  private parseOutput(login: ActiveLogin): void {
    const text = login.output.replace(ANSI_PATTERN, '');
    if (!login.state.authUrl) {
      for (const match of text.matchAll(URL_PATTERN)) {
        const url = officialAuthUrl(match[0]);
        if (!url) continue;
        login.state = { ...login.state, status: login.state.status === 'starting' ? 'waiting' : login.state.status, authUrl: url };
        break;
      }
    }
    if (!login.state.codePrompt && /paste code/i.test(text)) {
      login.state = { ...login.state, codePrompt: true, status: login.state.status === 'starting' ? 'waiting' : login.state.status };
    }
    if (login.state.authUrl) this.releaseUrlWaiters(login);
  }

  private releaseUrlWaiters(login: ActiveLogin): void {
    for (const resolve of login.urlWaiters.splice(0)) resolve();
  }

  private waitForUrl(login: ActiveLogin): Promise<void> {
    if (login.state.authUrl || this.active !== login) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(resolve, this.urlWaitMs);
    login.urlWaiters.push(() => { clearTimeout(timer); resolve(); });
    return promise;
  }

  private finish(login: ActiveLogin, status: ClaudeCodeLoginState['status'], error: string | null): void {
    if (this.active !== login) return;
    this.active = null;
    clearTimeout(login.timer);
    login.state = { ...login.state, status, error };
    this.last = login.state;
    this.releaseUrlWaiters(login);
    if (login.child.exitCode === null && login.child.signalCode === null) this.killTree(login.child);
  }

  private killTree(child: ChildProcess): void {
    try { child.stdin?.end(); } catch { /* already closed */ }
    // On Windows the CLI often runs under cmd.exe (npm's claude.cmd shim):
    // killing the shell alone leaves the CLI and its callback port alive.
    if (this.platform === 'win32' && child.pid) {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      return;
    }
    child.kill();
  }
}

/** `claude auth logout`, in the same environment every other CLI call uses. */
export async function logoutClaudeCode(claudePath: string): Promise<void> {
  const command = claudeCodeCommand(claudePath, ['auth', 'logout']);
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  execFile(command.executable, command.args, {
    encoding: 'utf8',
    env: claudeCodeChildEnvironment(),
    cwd: tmpdir(),
    timeout: LOGOUT_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
    windowsHide: true,
    windowsVerbatimArguments: command.windowsVerbatimArguments,
  }, (error, stdout, stderr) => {
    if (!error) { resolve(); return; }
    reject(new ClaudeCodeLoginError(502, failureText(`${stdout}\n${stderr}`, typeof error.code === 'number' ? error.code : null)));
  });
  return promise;
}
