// Skill script execution on the LOCAL machine — the equivalent of omp's
// "[Skill directory: baseDir] + terminal" for installed skills, but narrowed:
// whitelisted binaries only, no shell (execFile, so args never hit a shell),
// cwd locked to the skill directory, timeout, output cap, no env inheritance
// beyond PATH/HOME. Runs the deterministic scripts shipped with a skill
// (render.mjs, check-deps.sh, …) that a cloud sandbox cannot reach.
//
// The whitelist narrows WHAT can run but cannot make it safe (npx/uvx fetch and
// run registry code; an installed skill's scripts are third-party code), so
// every distinct command line additionally needs an explicit PROCESS_EXECUTION
// grant from the user through the capability broker. Default: deny.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, realpath } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { skillDirFor, skillFilesRoot } from '../skills-files.ts';
import { isCapabilityDenied, requireCapability } from '../security/capabilities.ts';
import { audit } from '../security/audit-log.ts';

const execFileAsync = promisify(execFile);

// Whitelisted binaries — deliberately small. No rm/sudo/curl/anything that
// would let an arbitrary skill reach outside its directory destructively.
const ALLOWED_BINARIES = new Set([
  'bash', 'sh', 'node', 'npm', 'npx', 'python3', 'python', 'uv', 'uvx',
  'ffmpeg', 'ffprobe', 'mkdir', 'cp', 'chmod',
]);

// Interpreters may only run a script FILE that lives inside the skill
// directory. Inline program text (`bash -c`, `node -e/--eval`, `python -c/-m`)
// is a full command-execution primitive the whitelist cannot contain, so the
// eval-style flags are rejected per interpreter (flag semantics differ: bash
// `-e` is errexit and legal, node `-e` is eval and not). Only the option
// region BEFORE the script path is scanned — the script's own arguments may
// legitimately contain `-c` etc.
const INTERPRETERS = new Set(['bash', 'sh', 'node', 'python3', 'python']);
const INLINE_EXEC_FLAGS: Record<string, RegExp> = {
  bash: /^-[A-Za-z]*c/,
  sh: /^-[A-Za-z]*c/,
  // -r/--require/--import/--loader preload arbitrary modules (including data:
  // URLs) before the "script", so they are inline execution too.
  node: /^(-[A-Za-z]*[epr]|--eval(=|$)|--print(=|$)|--require(=|$)|--import(=|$)|--(experimental-)?loader(=|$)|--inspect|--env-file)/,
  python: /^(-[A-Za-z]*[cm]|--command(=|$))/,
  python3: /^(-[A-Za-z]*[cm]|--command(=|$))/,
};

/** Reject interpreter invocations that execute anything but an in-dir script file. */
export function interpreterGuardError(dir: string, binary: string, args: string[]): string | null {
  if (!INTERPRETERS.has(binary)) return null;
  const pattern = INLINE_EXEC_FLAGS[binary]!;
  let script: string | undefined;
  for (const arg of args) {
    if (!arg.startsWith('-') || arg === '-') { script = arg === '-' ? undefined : arg; break; }
    if (pattern.test(arg)) return `inline execution flag not allowed for ${binary}: ${arg}`;
  }
  if (!script) return `${binary} requires a script file inside the skill directory`;
  const resolved = resolve(dir, script);
  if (resolved !== dir && !resolved.startsWith(dir + sep)) {
    return `script path escapes the skill directory: ${script}`;
  }
  // SKILL.md is free text any agent can rewrite through manage_skill; it is
  // documentation, never an executable script.
  if (basename(resolved).toLowerCase() === 'skill.md') {
    return 'SKILL.md is not an executable script';
  }
  return null;
}

/** Symlink-aware containment: the real script must also live in the skill dir. */
async function realScriptEscapes(dir: string, binary: string, args: string[]): Promise<boolean> {
  if (!INTERPRETERS.has(binary)) return false;
  const script = args.find((arg) => !arg.startsWith('-'));
  if (!script) return false;
  try {
    const [realDir, realScript] = await Promise.all([realpath(dir), realpath(resolve(dir, script))]);
    return realScript !== realDir && !realScript.startsWith(realDir + sep);
  } catch {
    return false; // A missing script fails at execFile time.
  }
}

const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 512 * 1024;

interface ExecRequest {
  command: string;
  args: string[];
  timeout?: number;
}

function readJson(req: IncomingMessage): Promise<ExecRequest> {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) { rejectPromise(new Error('request too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Partial<ExecRequest>;
        if (typeof parsed.command !== 'string' || !parsed.command.trim()) {
          rejectPromise(new Error('command is required'));
          return;
        }
        resolvePromise({
          command: parsed.command.trim(),
          args: Array.isArray(parsed.args)
            ? parsed.args.filter((a): a is string => typeof a === 'string')
            : [],
          timeout: typeof parsed.timeout === 'number' ? parsed.timeout : 60_000,
        });
      } catch { rejectPromise(new Error('invalid JSON')); }
    });
    req.on('error', rejectPromise);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function truncateOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_BYTES) return text;
  return `${text.slice(0, MAX_OUTPUT_BYTES)}\n…[truncated]`;
}

/** Run one whitelisted binary inside the skill directory. */
async function runInSkillDir(slug: string, body: ExecRequest): Promise<unknown> {
  const root = skillFilesRoot();
  const dir = skillDirFor(root, slug);
  if (!dir) return { error: `invalid skill slug "${slug}"` };
  try {
    await access(join(dir, 'SKILL.md'));
  } catch {
    return { error: `skill "${slug}" is not installed (no SKILL.md in ${dir})` };
  }
  const binary = body.command.split(/\s+/)[0] ?? '';
  if (!ALLOWED_BINARIES.has(binary)) {
    return { error: `command not allowed: "${binary}" — whitelist: ${[...ALLOWED_BINARIES].sort().join(', ')}` };
  }
  const rest = body.command.slice(binary.length).trim();
  const args = rest ? rest.split(/\s+/) : [];
  args.push(...body.args);
  const guardError = interpreterGuardError(dir, binary, args)
    ?? (await realScriptEscapes(dir, binary, args) ? 'script resolves outside the skill directory' : null);
  if (guardError) {
    audit({ event: 'process.blocked', capability: 'PROCESS_EXECUTION', action: 'skill.exec', target: `${slug}: ${binary}`, detail: guardError });
    return { error: guardError };
  }
  const commandLine = [binary, ...args].join(' ');
  try {
    await requireCapability({
      capability: 'PROCESS_EXECUTION',
      action: 'skill.exec',
      requester: 'agent',
      summary: `run a program from the skill "${slug}"`,
      detail: `Command: ${commandLine}\nWorking folder: the "${slug}" skill folder\n\nThis runs with your user account's permissions.`,
      scopeKey: `skill.exec:${slug}:${commandLine}`,
    });
  } catch (error) {
    if (isCapabilityDenied(error)) return { ok: false, denied: true, error: error.message };
    throw error;
  }
  audit({ event: 'process.exec', capability: 'PROCESS_EXECUTION', action: 'skill.exec', target: `${slug}: ${binary}` });
  const timeout = Math.min(Math.max(body.timeout ?? 60_000, 1_000), MAX_TIMEOUT_MS);
  try {
    const result = await execFileAsync(binary, args, {
      cwd: dir,
      timeout,
      maxBuffer: MAX_OUTPUT_BYTES,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    });
    return {
      ok: true,
      exitCode: 0,
      stdout: truncateOutput(result.stdout),
      stderr: truncateOutput(result.stderr),
      cwd: dir,
    };
  } catch (error) {
    const err = error as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean; message?: string };
    return {
      ok: false,
      exitCode: typeof err.code === 'number' ? err.code : (err.killed ? -9 : -1),
      killed: err.killed === true,
      stdout: truncateOutput(err.stdout ?? ''),
      stderr: truncateOutput(err.stderr ?? ''),
      error: err.message ?? String(error),
    };
  }
}

export function skillExecPlugin(): Plugin {
  return {
    name: 'openchatcut-skill-exec',
    configureServer(server) {
      server.middlewares.use('/api/skills', (req, res, next) => {
        // /api/skills/install and /api/skills/<slug>/exec are owned by their own plugins.
        if (req.url?.startsWith('/install')) { next(); return; }
        const execMatch = req.url?.match(/^\/([A-Za-z0-9_-]{1,120})\/exec$/);
        if (execMatch && req.method === 'POST') {
          void (async () => {
            try {
              const body = await readJson(req);
              const result = await runInSkillDir(execMatch[1]!, body);
              sendJson(res, 200, result);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              server.config.logger.error(`[api/skills/exec] ${message}`);
              if (!res.headersSent) sendJson(res, 400, { error: message });
            }
          })();
          return;
        }
        next();
      });
    },
  };
}
