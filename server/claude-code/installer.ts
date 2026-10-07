import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { ClaudeCodeInstallResult } from '../../shared/claude-code-agent.ts';
import { claudeCodeChildEnvironment } from './environment.ts';
import { resolveClaudeCodeCli } from './installation.ts';

/**
 * Runs Anthropic's official Claude Code installer, exactly the command the
 * Claude Code docs give (https://code.claude.com/docs/en/setup):
 *   Windows:       irm https://claude.ai/install.ps1 | iex
 *   macOS / Linux: curl -fsSL https://claude.ai/install.sh | bash
 * The command is fixed — nothing from the request reaches it. The native
 * installer needs no administrator rights and puts the CLI in
 * ~/.local/bin, which installation.ts probes directly.
 */

export const CLAUDE_CODE_INSTALL_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_LIMIT = 8 * 1024;
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export interface InstallerCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

export function claudeCodeInstallerCommand(platform: NodeJS.Platform = process.platform): InstallerCommand {
  if (platform === 'win32') {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    return {
      executable: `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      args: [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-Command', '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; irm https://claude.ai/install.ps1 | iex',
      ],
    };
  }
  // pipefail: a failed download must not read as an empty, successful script.
  return { executable: '/bin/bash', args: ['-c', 'set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash'] };
}

type SpawnLike = (executable: string, args: readonly string[], options: Parameters<typeof nodeSpawn>[2]) => ChildProcess;

let running: Promise<ClaudeCodeInstallResult> | null = null;

/** One install at a time; a second request waits for the first one's result. */
export function installClaudeCode(options: InstallOptions = {}): Promise<ClaudeCodeInstallResult> {
  if (running) return running;
  running = runInstaller(options).finally(() => { running = null; });
  return running;
}

interface InstallOptions {
  spawn?: SpawnLike;
  command?: InstallerCommand;
  timeoutMs?: number;
  /** Where the CLI is found afterwards; null fails the install. */
  locate?: () => Promise<string | null>;
}

async function runInstaller(options: InstallOptions): Promise<ClaudeCodeInstallResult> {
  const spawnProcess = options.spawn ?? ((executable, args, spawnOptions) => nodeSpawn(executable, args, spawnOptions));
  const command = options.command ?? claudeCodeInstallerCommand();
  const timeoutMs = options.timeoutMs ?? CLAUDE_CODE_INSTALL_TIMEOUT_MS;
  const started = Date.now();
  const child = spawnProcess(command.executable, command.args, {
    env: claudeCodeChildEnvironment(),
    cwd: tmpdir(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const collect = (chunk: Buffer | string) => { output = (output + chunk.toString()).slice(-OUTPUT_LIMIT); };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  const { promise, resolve } = Promise.withResolvers<{ code: number | null; error?: string; timedOut?: boolean }>();
  const timer = setTimeout(() => { child.kill(); resolve({ code: null, timedOut: true }); }, timeoutMs);
  child.once('error', (error) => { clearTimeout(timer); resolve({ code: null, error: error.message }); });
  child.once('close', (code) => { clearTimeout(timer); resolve({ code }); });
  const outcome = await promise;
  const lines = output.replace(ANSI_PATTERN, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const tail = lines.slice(-6).join('\n').slice(0, 1200);
  const durationMs = Date.now() - started;
  if (outcome.error) return { ok: false, message: `Could not start the installer: ${outcome.error}`, durationMs };
  if (outcome.timedOut) return { ok: false, message: 'The Claude Code installer did not finish within 10 minutes.', durationMs };
  if (outcome.code !== 0) {
    return { ok: false, message: tail || `The Claude Code installer exited with code ${outcome.code ?? 'unknown'}.`, durationMs };
  }
  // Trust the result, not the exit code: the CLI has to be where OpenChatCut looks.
  const located = await (options.locate ?? resolveClaudeCodeCli)();
  if (!located) {
    return {
      ok: false,
      message: `${tail ? `${tail}\n` : ''}The installer finished, but the claude executable was not found afterwards.`,
      durationMs,
    };
  }
  return { ok: true, message: `${tail || 'Claude Code installed.'}\n${located}`, durationMs };
}
