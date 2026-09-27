// Performs a storage-root move the user requested in settings, before any
// module resolves the runtime profile or opens the project store. Imported
// for its side effect as an early import of desktop/main.ts (right after
// chdir-first.ts, since the packaged profile is cwd-relative) and as the first
// import of config/vite.config.ts; ESM runs imports depth-first in order, and
// this module must not import runtime-profile.ts. See data-dir-relocation.ts.
import { applyPendingRelocationSync } from './data-dir-relocation.ts';

const pinned = Boolean(process.env.OPENCHATCUT_DATA_DIR?.trim())
  || Object.hasOwn(process.env, 'OPENCHATCUT_DEV_PROFILE_ID');
if (!pinned) applyPendingRelocationSync();
