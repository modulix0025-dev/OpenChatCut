// Agent access to local media folders (browse + path import). Least
// privilege: the agent only reaches folders the user picked in the native
// folder picker, recorded in AGENT_IMPORT_ROOTS. When a request needs a folder
// that has not been granted, the picker is shown and the request retried.
import { existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron';
import { browseLocalMedia } from '../server/agent-local-media.ts';
import { getKey, setKeys } from '../server/keystore.ts';
import {
  AGENT_IMPORT_ROOTS_KEY,
  appendAgentImportRoot,
  importAgentPathsWithGrant,
} from '../server/local-path-import.ts';
import { audit } from '../server/security/audit-log.ts';
import { isSafeLocalPath } from '../server/security/local-path-safety.ts';
import { AGENT_LOCAL_MEDIA_CHANNEL } from '../shared/agent-local-media.ts';
import { AGENT_PATH_IMPORT_CHANNEL } from '../shared/directory-import.ts';
import { assertTrustedDesktopSenderUrl } from './page-origin.ts';

function agentImportPickerDefaultPath(requestedPath: string): string {
  // Never stat a UNC/device path an agent supplied: touching \\host\share makes
  // Windows authenticate to that host.
  if (!isSafeLocalPath(requestedPath)) return app.getPath('videos');
  try {
    return existsSync(requestedPath) && statSync(requestedPath).isDirectory()
      ? requestedPath
      : dirname(requestedPath);
  } catch {
    return dirname(requestedPath);
  }
}

export function installAgentFolderGrantIpc(origin: string): void {
  ipcMain.handle(AGENT_LOCAL_MEDIA_CHANNEL, async (event, request: unknown) => {
    assertTrustedDesktopSenderUrl(event.senderFrame?.url ?? '', origin);
    try {
      return await browseLocalMedia(request);
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (code !== 'IMPORT_ROOTS_NOT_CONFIGURED' && code !== 'PATH_OUTSIDE_IMPORT_ROOTS') throw error;
      // Least privilege: the agent sees only folders the user picks here.
      const requested = (request as { path?: unknown })?.path;
      const parent = BrowserWindow.fromWebContents(event.sender);
      const options: OpenDialogOptions = {
        title: '选择允许 Agent 访问的素材文件夹 / Choose a folder the agent may browse',
        defaultPath: agentImportPickerDefaultPath(typeof requested === 'string' ? requested : app.getPath('videos')),
        properties: ['openDirectory'],
      };
      const selected = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      const root = selected.canceled ? null : selected.filePaths[0];
      if (!root) throw error;
      await setKeys({ [AGENT_IMPORT_ROOTS_KEY]: appendAgentImportRoot(getKey(AGENT_IMPORT_ROOTS_KEY as never), root) });
      audit({ event: 'capability.granted', capability: 'FILES_READ', action: 'agent.import-root', decision: 'folder-picker', target: root });
      return browseLocalMedia(typeof requested === 'string' ? request : { ...(request as object), path: root });
    }
  });
  ipcMain.handle(AGENT_PATH_IMPORT_CHANNEL, async (event, request: unknown) => {
    assertTrustedDesktopSenderUrl(event.senderFrame?.url ?? '', origin);
    const value = request as { paths?: unknown; projectId?: unknown; knownHashes?: unknown };
    const paths = Array.isArray(value?.paths)
      ? value.paths.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0 && entry.length < 4096)
      : [];
    const knownHashes = Array.isArray(value?.knownHashes)
      ? value.knownHashes.filter((entry): entry is string => typeof entry === 'string' && entry.length <= 128)
      : [];
    if (!paths.length || paths.length > 100 || paths.length !== (value.paths as unknown[]).length
      || typeof value?.projectId !== 'string') {
      throw new Error('invalid agent path import request');
    }
    return importAgentPathsWithGrant({ paths, projectId: value.projectId, knownHashes }, {
      chooseRoot: async (requestedPath) => {
        const parent = BrowserWindow.fromWebContents(event.sender);
        const options: OpenDialogOptions = {
          title: '选择允许 Agent 访问的素材文件夹',
          defaultPath: agentImportPickerDefaultPath(requestedPath),
          properties: ['openDirectory'],
        };
        const selected = parent
          ? await dialog.showOpenDialog(parent, options)
          : await dialog.showOpenDialog(options);
        return selected.canceled ? null : (selected.filePaths[0] ?? null);
      },
      readRoots: () => getKey(AGENT_IMPORT_ROOTS_KEY as never),
      writeRoots: (roots) => setKeys({ [AGENT_IMPORT_ROOTS_KEY]: roots }),
    });
  });
}
