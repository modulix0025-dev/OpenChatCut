import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeCodeConnectionTestResult } from '../../shared/claude-code-agent.ts';
import { claudeCodeCommand } from './command.ts';
import { claudeCodeChildEnvironment } from './environment.ts';
import { DENIED_TOOLS } from './turn-runner.ts';

export const CLAUDE_CODE_TEST_TIMEOUT_MS = 120_000;
const OUTPUT_LIMIT = 256 * 1024;
const TEST_PROMPT = 'Connection check from OpenChatCut. Reply with the single word OK.';

/**
 * A real one-message `claude -p` round trip, run with the same environment and
 * sandbox flags as an agent turn (minus the editor's MCP server). "Signed in"
 * in `auth status` only means credentials exist; this proves they work — an
 * expired token, a revoked subscription or a blocked network shows up here
 * with the CLI's own message instead of as a silent failed turn.
 */
export async function testClaudeCodeConnection(
  claudePath: string,
  model?: string,
  timeoutMs = CLAUDE_CODE_TEST_TIMEOUT_MS,
): Promise<ClaudeCodeConnectionTestResult> {
  const started = Date.now();
  const dir = await mkdtemp(join(tmpdir(), 'occ-claude-test-'));
  try {
    const args = [
      '-p', TEST_PROMPT,
      '--output-format', 'json',
      '--no-session-persistence',
      '--strict-mcp-config',
      '--disallowedTools', DENIED_TOOLS,
      '--restricted',
      '--permission-prompts', 'none',
    ];
    if (model) args.push('--model', model);
    const command = claudeCodeCommand(claudePath, args);
    const child = spawn(command.executable, command.args, {
      env: claudeCodeChildEnvironment(),
      cwd: dir,
      windowsHide: true,
      windowsVerbatimArguments: command.windowsVerbatimArguments,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString('utf8')).slice(-OUTPUT_LIMIT); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-8192); });
    const { promise, resolve } = Promise.withResolvers<{ code: number | null; timedOut: boolean; spawnError?: string }>();
    const timer = setTimeout(() => { child.kill(); resolve({ code: null, timedOut: true }); }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); resolve({ code: null, timedOut: false, spawnError: error.message }); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, timedOut: false }); });
    const outcome = await promise;
    const durationMs = Date.now() - started;
    if (outcome.spawnError) return { ok: false, message: `Could not start Claude Code: ${outcome.spawnError}`, durationMs };
    if (outcome.timedOut) {
      return { ok: false, message: `Claude Code did not answer within ${Math.round(timeoutMs / 1000)} s.`, durationMs };
    }
    return interpretTestOutput(stdout, stderr, outcome.code, durationMs);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Reads the CLI's `--output-format json` result. Exported for verify tests. */
export function interpretTestOutput(
  stdout: string,
  stderr: string,
  exitCode: number | null,
  durationMs: number,
): ClaudeCodeConnectionTestResult {
  const lines = stdout.trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const result = parsed as Record<string, unknown>;
    if (result.type !== 'result') continue;
    const text = typeof result.result === 'string' ? result.result.trim() : '';
    const usage = result.modelUsage && typeof result.modelUsage === 'object'
      ? Object.keys(result.modelUsage as Record<string, unknown>)[0] : undefined;
    if (result.is_error === true || result.subtype !== 'success') {
      return { ok: false, message: (text || 'Claude Code reported an error.').slice(0, 500), durationMs };
    }
    return { ok: true, message: text.slice(0, 200) || 'OK', durationMs, ...(usage ? { model: usage } : {}) };
  }
  const detail = `${stderr}\n${stdout}`.trim().split(/\r?\n/).filter(Boolean).at(-1)?.slice(0, 500);
  return { ok: false, message: detail || `Claude Code exited with code ${exitCode ?? 'unknown'}.`, durationMs };
}
