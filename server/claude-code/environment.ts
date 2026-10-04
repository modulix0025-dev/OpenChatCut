/**
 * The one environment every Claude Code CLI subprocess gets: `auth status`,
 * `auth login` / `logout`, the connection test and the agent turn itself.
 *
 * They used to differ — status inherited the whole server environment while
 * the turn got a short allow-list — so the settings card could report
 * "signed in" (the CLI saw CLAUDE_CODE_OAUTH_TOKEN or a custom
 * CLAUDE_CONFIG_DIR) while every turn ran signed out. On Windows the
 * allow-list also dropped the system variables the native CLI needs to find
 * Git Bash and Program Files. One builder, used everywhere, keeps what the
 * card shows and what the turn does identical.
 *
 * Still an allow-list: the app's own provider keys and unrelated secrets in
 * the server's environment never reach the CLI.
 */
const SYSTEM_ENV_NAMES = [
  'PATH', 'Path', 'PATHEXT',
  'HOME', 'USER', 'LOGNAME', 'USERPROFILE', 'USERNAME', 'USERDOMAIN',
  'HOMEDRIVE', 'HOMEPATH', 'SystemDrive', 'SystemRoot', 'WINDIR', 'windir',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'ALLUSERSPROFILE',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432',
  'COMPUTERNAME', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
  'COMSPEC', 'ComSpec', 'PSModulePath',
  'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_ENV_PROXY',
  'NO_COLOR', 'FORCE_COLOR',
] as const;

/**
 * What decides which account the CLI uses, exactly as it would in the user's
 * terminal. Passed through so the in-app sign-in, the status card and every
 * turn agree; the card warns when one of the token variables overrides the
 * browser sign-in.
 */
export const CLAUDE_CODE_AUTH_ENV_NAMES = [
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_GIT_BASH_PATH',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
] as const;

/** Variables that make the CLI ignore the account signed in through the browser. */
export const CLAUDE_CODE_OVERRIDE_ENV_NAMES = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
] as const;

export function claudeCodeChildEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [...SYSTEM_ENV_NAMES, ...CLAUDE_CODE_AUTH_ENV_NAMES]) {
    const value = source[name];
    if (value !== undefined && value !== '') environment[name] = value;
  }
  return environment;
}

/** Names (never values) of the override variables currently set. */
export function claudeCodeEnvOverrides(source: NodeJS.ProcessEnv = process.env): string[] {
  return CLAUDE_CODE_OVERRIDE_ENV_NAMES.filter((name) => (source[name] ?? '').trim() !== '');
}
