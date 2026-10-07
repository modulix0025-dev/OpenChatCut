import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path';
import { claudeCodeCommand } from './command.ts';

const VERSION_TIMEOUT_MS = 10_000;
const VERSION_OUTPUT_LIMIT = 16 * 1024;
/**
 * Floor covering every flag this backend passes: --mcp-config / --strict-mcp-config /
 * --output-format stream-json, plus the sandbox flags added for the hardened turn
 * run (--restricted, --disallowedTools, --permission-prompts). 2.1.263 is the version
 * that combination was verified against; an older CLI must not be driven with it.
 */
export const MINIMUM_CLAUDE_CODE_VERSION = '2.1.263';

export interface ClaudeCodeInstallation {
  readonly installed: boolean;
  readonly supported: boolean;
  readonly path: string | null;
  readonly version: string | null;
}

function executableNames(name = 'claude'): string[] {
  if (process.platform !== 'win32' || /\.(?:exe|cmd|bat)$/i.test(name)) return [name];
  return [`${name}.exe`, `${name}.cmd`, `${name}.bat`];
}

function pathCandidates(name: string): string[] {
  const entries = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  return entries.flatMap((entry) => executableNames(name).map((file) => join(entry, file)));
}

function configuredCandidates(): string[] {
  const configured = process.env.OPENCHATCUT_CLAUDE_CODE_PATH?.trim();
  if (!configured) return [];
  if (isAbsolute(configured) || configured.includes(sep) || configured.includes('/')) {
    return [resolve(configured)];
  }
  return pathCandidates(configured);
}

/**
 * Where each official (and common) Windows install method puts the CLI. A
 * desktop app started from the Start menu often has an older PATH than the
 * terminal the user installed from, so the known locations are probed
 * directly instead of trusting PATH alone.
 */
export function windowsCandidates(): string[] {
  const env = process.env;
  const profile = env.USERPROFILE || homedir();
  const appData = env.APPDATA || join(profile, 'AppData', 'Roaming');
  const localAppData = env.LOCALAPPDATA || join(profile, 'AppData', 'Local');
  const programFiles = [env.ProgramFiles, env.ProgramW6432, 'C:\\Program Files'].filter(Boolean) as string[];
  return [
    // Native installer (irm https://claude.ai/install.ps1 | iex)
    join(profile, '.local', 'bin', 'claude.exe'),
    // WinGet (winget install Anthropic.ClaudeCode)
    join(localAppData, 'Microsoft', 'WinGet', 'Links', 'claude.exe'),
    // npm global, default prefix and nvm / Node installer prefixes
    join(appData, 'npm', 'claude.cmd'),
    join(appData, 'npm', 'claude.exe'),
    ...(env.NVM_SYMLINK ? [join(env.NVM_SYMLINK, 'claude.cmd')] : []),
    'C:\\nvm4w\\nodejs\\claude.cmd',
    ...programFiles.map((dir) => join(dir, 'nodejs', 'claude.cmd')),
    // Other package managers
    join(localAppData, 'Programs', 'claude', 'claude.exe'),
    join(localAppData, 'pnpm', 'claude.cmd'),
    join(profile, 'scoop', 'shims', 'claude.exe'),
    join(profile, '.bun', 'bin', 'claude.exe'),
    join(profile, '.volta', 'bin', 'claude.exe'),
  ];
}

/** WinGet's package folder carries a version suffix, so it is listed, not guessed. */
async function wingetPackageCandidates(): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  const packages = join(localAppData, 'Microsoft', 'WinGet', 'Packages');
  try {
    const entries = await readdir(packages, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && /^Anthropic\.ClaudeCode/i.test(entry.name))
      .map((entry) => join(packages, entry.name, 'claude.exe'));
  } catch {
    return [];
  }
}

function commonCandidates(): string[] {
  const home = homedir();
  if (process.platform === 'win32') return windowsCandidates();
  return [
    join(home, '.local', 'bin', 'claude'),
    join(home, '.npm-global', 'bin', 'claude'),
    join(home, '.bun', 'bin', 'claude'),
    join(home, '.volta', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ];
}

async function executable(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return false;
    if (process.platform !== 'win32') await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveClaudeCodeCli(): Promise<string | null> {
  const candidates = [
    ...configuredCandidates(),
    ...pathCandidates('claude'),
    ...commonCandidates(),
    ...await wingetPackageCandidates(),
  ];
  const unique = [...new Set(candidates)];
  const checks = await Promise.all(unique.map(async (candidate) => ({
    candidate,
    executable: await executable(candidate),
  })));
  return checks.find((check) => check.executable)?.candidate ?? null;
}

function parseVersion(output: string): string | null {
  const match = output.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
  return match?.[1] ?? null;
}

function versionParts(version: string): readonly number[] {
  return version.split(/[.+-]/, 3).map((part) => Number.parseInt(part, 10));
}

export function isSupportedClaudeCodeVersion(version: string | null): boolean {
  if (!version) return false;
  const actual = versionParts(version);
  const minimum = versionParts(MINIMUM_CLAUDE_CODE_VERSION);
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) return (actual[index] ?? 0) > (minimum[index] ?? 0);
  }
  return true;
}

async function readVersion(path: string): Promise<string | null> {
  const command = claudeCodeCommand(path, ['--version']);
  const { promise, resolve } = Promise.withResolvers<string | null>();
  execFile(command.executable, command.args, {
    encoding: 'utf8',
    timeout: VERSION_TIMEOUT_MS,
    maxBuffer: VERSION_OUTPUT_LIMIT,
    windowsHide: true,
    windowsVerbatimArguments: command.windowsVerbatimArguments,
  }, (error, stdout, stderr) => {
    resolve(error ? null : parseVersion(`${stdout}\n${stderr}`));
  });
  return promise;
}

export async function inspectClaudeCodeInstallation(): Promise<ClaudeCodeInstallation> {
  const path = await resolveClaudeCodeCli();
  if (!path) return { installed: false, supported: false, path: null, version: null };
  const version = await readVersion(path);
  return { installed: true, supported: isSupportedClaudeCodeVersion(version), path, version };
}
