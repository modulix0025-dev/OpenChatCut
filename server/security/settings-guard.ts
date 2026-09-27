// Settings changes that can leak credentials or relocate user data must be
// confirmed by the user through the capability broker, whoever submits them.
//
// A same-origin POST to /api/keys can come from the settings panel, but also
// from any script that manages to run in the editor origin (a malicious
// template, a compromised dependency). Stored API keys never leave the main
// process, but they follow the provider base URL: pointing OPENAI_BASE_URL (or
// PROXY_URL) at another host would send the stored key there. The same goes
// for "Test connection" with an overridden URL and the stored key.
import { NON_SECRET_NAMES } from '../keystore-names.ts';
import { requireCapability } from './capabilities.ts';

const ENDPOINT_KEY = /(BASE_URL|API_BASE|ENDPOINT|PROXY_URL)$/;
// Settings that are not URLs but choose the host credentials are sent to
// (R2 requests go to https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com).
const HOST_DERIVING_KEYS: ReadonlySet<string> = new Set(['R2_ACCOUNT_ID']);

export function isEndpointSetting(name: string): boolean {
  return ENDPOINT_KEY.test(name) || HOST_DERIVING_KEYS.has(name);
}

/** host[:port] of an endpoint value, lower-cased; the raw text when unparsable. */
export function endpointHost(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed).host.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

/** The endpoint as shown to the user: never includes URL credentials. */
export function displayEndpoint(value: string): string {
  try {
    const url = new URL(value.trim());
    url.username = '';
    url.password = '';
    return url.href;
  } catch {
    return value.trim().replace(/\/\/[^/@\s]*@/, '//');
  }
}

async function confirmEndpoint(name: string, value: string, action: string): Promise<void> {
  const host = endpointHost(value);
  await requireCapability({
    capability: 'CREDENTIALS',
    action,
    requester: 'editor',
    summary: name === 'PROXY_URL'
      ? 'route its network traffic (including API keys) through a proxy server'
      : `send ${name.replace(/_(BASE_URL|API_BASE|ENDPOINT)$/, '')} requests, with your stored API key, to a different server`,
    detail: `Setting: ${name}\nServer: ${displayEndpoint(value)}`,
    scopeKey: `settings.endpoint:${name}:${host}`,
  });
}

export interface DirectorySetting {
  readonly name: string;
  readonly label: string;
  /** Normalized current location (to decide whether the value changes). */
  readonly current: string;
  /** Normalized requested location, or null when the value resets to the default. */
  readonly requested: string | null;
}

/**
 * Ask before a settings patch redirects stored credentials to a new host or
 * moves where user data is stored. Unchanged values never prompt.
 */
export async function authorizeSettingsPatch(
  patch: Readonly<Record<string, unknown>>,
  currentValue: (name: string) => string,
  directories: readonly DirectorySetting[] = [],
): Promise<void> {
  for (const [name, raw] of Object.entries(patch)) {
    if (!isEndpointSetting(name)) continue;
    const value = String(raw ?? '').trim();
    if (!value || endpointHost(value) === endpointHost(currentValue(name))) continue;
    await confirmEndpoint(name, value, 'settings.endpoint');
  }
  for (const directory of directories) {
    if (directory.requested === null || directory.requested === directory.current) continue;
    await requireCapability({
      capability: 'FILES_WRITE',
      action: 'settings.directory',
      requester: 'editor',
      summary: `store ${directory.label} in a different folder`,
      detail: `Setting: ${directory.name}\nNew folder: ${directory.requested}\nExisting files are copied there.`,
      scopeKey: `settings.dir:${directory.name}:${directory.requested}`,
    });
  }
}

/**
 * "Test connection" with unsaved overrides: when the test would combine a NEW
 * endpoint with a STORED secret, the user must confirm. Tests that bring their
 * own (unsaved) key, or keep the stored endpoint, run without prompting.
 */
export async function authorizeProbeOverrides(
  overrides: Readonly<Record<string, unknown>>,
  currentValue: (name: string) => string,
): Promise<void> {
  const bringsOwnSecret = Object.entries(overrides).some(([name, raw]) => (
    !NON_SECRET_NAMES.has(name) && !isEndpointSetting(name) && String(raw ?? '').trim().length > 0
  ));
  if (bringsOwnSecret) return;
  for (const [name, raw] of Object.entries(overrides)) {
    if (!isEndpointSetting(name)) continue;
    const value = String(raw ?? '').trim();
    if (!value || endpointHost(value) === endpointHost(currentValue(name))) continue;
    await confirmEndpoint(name, value, 'settings.endpoint-test');
  }
}
