import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { getKey, keyStatus, redactUrlCredentials, setKeys } from '../keystore.ts';
import { authorizeProbeOverrides, authorizeSettingsPatch, type DirectorySetting } from '../security/settings-guard.ts';
import { isCapabilityDenied } from '../security/capabilities.ts';
import { runProbe } from '../key-probes.ts';
import {
  checkMediaDir,
  DEFAULT_UPLOAD_DIR,
  expandMediaDir,
  syncUploadDirectories,
  uploadDir,
} from '../media-dir.ts';
import {
  DATA_DIR_ENV,
  defaultRootDir,
  isIsolatedDevProfile,
  runtimeProfile,
  type RuntimeProfile,
} from '../runtime-profile.ts';
import {
  checkDataDir,
  expandDataDir,
  readDataDirPointer,
  relocatedMediaDestination,
  writeDataDirPointer,
} from '../data-dir.ts';
import {
  clearPendingRelocation,
  isCloudSyncedPath,
  projectDataIn,
  readPendingRelocation,
  readRelocationReport,
  writePendingRelocation,
} from '../data-dir-relocation.ts';
import { sqliteStoreEnabled } from '../storage/sqlite-store.ts';

const ISOLATED_R2_SETTINGS = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'R2_ENABLED',
  'R2_PRESIGN',
] as const;

export function assertProfileSensitiveSettingsPatch(
  patch: Readonly<Record<string, unknown>>,
  profile: RuntimeProfile = runtimeProfile(),
): void {
  if (!isIsolatedDevProfile(profile)) return;
  if (Object.hasOwn(patch, 'MEDIA_DIR')) {
    throw new Error('MEDIA_DIR cannot be changed while an isolated development profile is active');
  }
  if (ISOLATED_R2_SETTINGS.some((name) => Object.hasOwn(patch, name))) {
    throw new Error('R2 settings cannot be changed while an isolated development profile is active');
  }
}

// Dev-only settings endpoint bound to the Vite dev server (localhost). Key VALUES flow
// browser → server here and are stored server-side + in .env.local; they never flow back
// (GET returns booleans only); keys never leave the server.
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > 100_000) throw new Error('request body too large');
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    // Generic message on purpose: V8's SyntaxError can echo the raw body (which may
    // contain a key value) and our catch-all logs error messages.
    throw new Error('invalid JSON body');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be a JSON object');
  return parsed as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

/** keyStatus + absolute path to the current asset directory. FCPXML export goes to /media/uploads/<name>
 * Convert to real disk path, otherwise every asset in NLE will be offline; the directory changes with MEDIA_DIR,
 * Only the server knows, so it is returned to the front-end along with the settings (non-key, can be disclosed). */
function settingsBody(restartRequired = false) {
  const profile = runtimeProfile();
  const status = keyStatus();
  // A move saved but not yet applied shows its target, with the restart notice.
  const pending = readPendingRelocation();
  const configured = (pending ? pending.targetPointer : readDataDirPointer()) ?? '';
  // The outcome of the last startup move, shown on the storage page for a week.
  const report = readRelocationReport();
  const relocation = report && Date.now() - Date.parse(report.at) < 7 * 86_400_000 ? report : null;
  return {
    ...status,
    // The storage root is configuration, not a credential: echo it raw so the
    // settings field shows where projects actually live. It is not a keystore
    // key (the keystore lives inside the root), hence the explicit merge.
    models: { ...status.models, [DATA_DIR_ENV]: configured },
    mediaDir: uploadDir(),
    dataDir: profile.rootDir,
    ...(restartRequired || pending ? { restartRequired: true } : {}),
    ...(relocation ? { lastRelocation: relocation } : {}),
  };
}

/** A move into a folder that already holds OpenChatCut projects needs the
 *  user's explicit choice; the settings page asks and resubmits. */
export class DataDirConflictError extends Error {
  readonly code = 'data-dir-has-data';
  readonly newestMtimeMs: number | null;
  constructor(dir: string, newestMtimeMs: number | null) {
    super(`${dir} already contains OpenChatCut projects`
      + (newestMtimeMs ? ` (last changed ${new Date(newestMtimeMs).toISOString()})` : '')
      + '. Choose whether to replace them with your current projects (they are kept as a backup) or to use them.');
    this.name = 'DataDirConflictError';
    this.newestMtimeMs = newestMtimeMs;
  }
}

/** Patch field carrying that choice; never stored. */
export const DATA_DIR_EXISTING_FIELD = 'OPENCHATCUT_DATA_DIR_EXISTING';

export interface DataDirChangeResult { warning?: string }

/** Apply a storage-root change: validate, pre-copy media, and record the move
 *  as pending. The projects themselves are copied by the next launch, before
 *  the store opens (server/data-dir-relocation.ts), so edits made after saving
 *  this setting are not left behind in the old folder.
 *
 *  Media is copied from the RESOLVED upload directory, not from `<root>/media`:
 *  in the default profile uploads live outside the root (the checkout's
 *  `public/media/uploads`, or `userData/...` when packaged), so copying the
 *  root's own `media` folder would move an empty directory and take every
 *  `/media/uploads/...` reference offline after the restart. */
async function applyDataDirChange(
  raw: string,
  existingChoice: unknown,
  profile: RuntimeProfile,
  log: (msg: string) => void,
): Promise<DataDirChangeResult> {
  if (process.env[DATA_DIR_ENV]?.trim()) {
    throw new Error(`storage directory is pinned by ${DATA_DIR_ENV} and cannot be changed from settings`);
  }
  if (isIsolatedDevProfile(profile)) {
    throw new Error('storage directory cannot be changed while an isolated development profile is active');
  }
  const checked = await checkDataDir(raw, defaultRootDir(profile));
  if (!checked.ok) throw new Error(checked.error ?? 'invalid storage directory');
  const target = expandDataDir(raw);
  // Clearing the field is a relocation too: it sends the next launch back to the
  // default root, which is empty or stale for anyone who has been running
  // elsewhere. Treating it as "no move" would skip both the SQLite refusal and
  // the copy, and lose the projects exactly like the case this guards against.
  const destination = target ?? defaultRootDir(profile);
  if (destination === profile.rootDir) {
    // Back to where the app already runs: cancel any pending move.
    clearPendingRelocation();
    await writeDataDirPointer(target);
    return {};
  }
  if (sqliteStoreEnabled()) {
    throw new Error(
      'the project store has been migrated to SQLite and cannot be relocated yet: '
      + 'moving a live database needs a quiesced snapshot, which this setting does not do',
    );
  }
  const choice = existingChoice === 'replace' || existingChoice === 'use-existing' ? existingChoice : null;
  const existing = projectDataIn(destination);
  if (existing.entries.length && !choice) throw new DataDirConflictError(destination, existing.newestMtimeMs);
  const mediaFrom = uploadDir(profile);
  // Uploads are addressed by name through uploadReadDirs(), so the copy must
  // land where the relocated profile will resolve its writable upload dir.
  const mediaTo = relocatedMediaDestination(target, destination, DEFAULT_UPLOAD_DIR);
  if (choice !== 'use-existing') await syncUploadDirectories(mediaFrom, mediaTo, log);
  writePendingRelocation({
    version: 1,
    fromRoot: profile.rootDir,
    toRoot: destination,
    targetPointer: target,
    fromMedia: mediaFrom,
    toMedia: mediaTo,
    existing: existing.entries.length ? choice ?? 'none' : 'none',
    requestedAt: new Date().toISOString(),
  });
  log(`[data-dir] move to ${destination} scheduled for the next launch`);
  return isCloudSyncedPath(destination)
    ? { warning: 'This folder is synced by a cloud client (OneDrive, Dropbox, iCloud or Google Drive). Sync clients can lock, rewrite or keep files online-only while OpenChatCut writes them; a local folder is safer.' }
    : {};
}

export function settingsPlugin(): Plugin {
  return {
    name: 'openchatcut-settings',
    configureServer(server) {
      server.middlewares.use('/api/keys', async (req, res) => {
        try {
          if (req.method === 'GET') { sendJson(res, 200, settingsBody()); return; }
          // POST /api/keys/test: "Test connection" detection. overrides = unsaved temporary values of the panel,
          // Only this detection takes effect and does not fall into keystore / .env.local; the result will never contain the key value.
          if (req.method === 'POST' && req.url === '/test') {
            const body = await readBody(req);
            const page = typeof body.page === 'string' ? body.page : '';
            const overrides = body.overrides && typeof body.overrides === 'object' && !Array.isArray(body.overrides)
              ? body.overrides as Record<string, unknown>
              : {};
            await authorizeProbeOverrides(overrides, (name) => getKey(name as never));
            sendJson(res, 200, await runProbe(page, overrides));
            return;
          }
          if (req.method === 'POST') {
            const profile = runtimeProfile();
            const patch = await readBody(req);
            assertProfileSensitiveSettingsPatch(patch, profile);
            // GET /api/keys shows PROXY_URL as scheme://***@host; saving the form
            // unchanged must keep the stored credentials, not store "***".
            if (typeof patch.PROXY_URL === 'string' && patch.PROXY_URL.includes('://***@')) {
              const stored = getKey('PROXY_URL' as never);
              if (redactUrlCredentials(stored) === patch.PROXY_URL.trim()) patch.PROXY_URL = stored;
              else throw new Error('re-enter the proxy credentials to change the proxy address');
            }
            // Redirecting stored keys to a new host or moving user data needs
            // the user's explicit confirmation (native prompt on desktop).
            const directories: DirectorySetting[] = [];
            if (Object.hasOwn(patch, DATA_DIR_ENV)) {
              const requested = expandDataDir(String(patch[DATA_DIR_ENV] ?? ''));
              directories.push({ name: DATA_DIR_ENV, label: 'your projects', current: profile.rootDir, requested: requested ?? defaultRootDir(profile) });
            }
            if ('MEDIA_DIR' in patch) {
              directories.push({ name: 'MEDIA_DIR', label: 'your media library', current: uploadDir(profile), requested: expandMediaDir(String(patch.MEDIA_DIR ?? '')) ?? profile.mediaDir });
            }
            if ('OPENCHATCUT_SKILLS_DIR' in patch) {
              const requested = String(patch.OPENCHATCUT_SKILLS_DIR ?? '').trim();
              directories.push({ name: 'OPENCHATCUT_SKILLS_DIR', label: 'your skills', current: getKey('OPENCHATCUT_SKILLS_DIR' as never).trim(), requested: requested || null });
            }
            await authorizeSettingsPatch(patch, (name) => getKey(name as never), directories);
            // The storage root is not a keystore key (the keystore lives inside
            // it): handle and strip it before setKeys sees the patch.
            let dataDirChanged = false;
            let dataDirWarning: string | undefined;
            if (Object.hasOwn(patch, DATA_DIR_ENV)) {
              const result = await applyDataDirChange(
                String(patch[DATA_DIR_ENV] ?? ''),
                patch[DATA_DIR_EXISTING_FIELD],
                profile,
                (msg) => server.config.logger.info(msg),
              );
              delete patch[DATA_DIR_ENV];
              dataDirChanged = true;
              dataDirWarning = result.warning;
            }
            delete patch[DATA_DIR_EXISTING_FIELD];
            const previousMediaDir = uploadDir(profile);
            if ('MEDIA_DIR' in patch) {
              const rawMediaDir = String(patch.MEDIA_DIR ?? '');
              const checked = await checkMediaDir(rawMediaDir, profile);
              if (!checked.ok) throw new Error(checked.error ?? 'invalid media directory');
              const nextMediaDir = expandMediaDir(rawMediaDir) ?? profile.mediaDir;
              await syncUploadDirectories(
                previousMediaDir,
                nextMediaDir,
                (msg) => server.config.logger.info(msg),
              );
            }
            await setKeys(patch);
            sendJson(res, 200, { ...settingsBody(dataDirChanged), ...(dataDirWarning ? { dataDirWarning } : {}) });
            return;
          }
          sendJson(res, 405, { error: 'method not allowed — use GET or POST' });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[settings] ${message}`);  // message only — never a key value
          if (!res.headersSent) {
            const conflict = error instanceof DataDirConflictError
              ? { code: error.code, newestMtimeMs: error.newestMtimeMs }
              : {};
            sendJson(res, isCapabilityDenied(error) ? 403 : error instanceof DataDirConflictError ? 409 : 400, { error: message, ...conflict });
          }
        }
      });
    },
  };
}
