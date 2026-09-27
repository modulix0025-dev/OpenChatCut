// Agent-initiated local-path import (issue #84 Feature B). Unlike directory
// watches, which wait passively for files to appear, this runs a one-shot
// scan/import of explicitly requested paths.
//
// Least privilege: the agent (and external MCP clients) may only reach folders
// the user granted through the native folder picker, recorded in
// AGENT_IMPORT_ROOTS. With no grant, every path is refused with
// IMPORT_ROOTS_NOT_CONFIGURED so the desktop can ask the user for a folder.
import { basename, dirname, isAbsolute } from 'node:path';
import { realpath, stat, readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { getKey } from './keystore.ts';
import { unsafeLocalPathReason } from './security/local-path-safety.ts';
import { audit } from './security/audit-log.ts';
import type {
  AgentPathImportRequest,
  AgentPathImportError,
  AgentPathImportResult,
  DirectoryImportedFile,
} from '../shared/directory-import.ts';
import { scanImportDirectory } from './directory-watch.ts';
import {
  canonicalCurrentUploadDirectory,
  importDirectoryCandidate,
  isPathInside,
  type DirectoryCandidateRequest,
} from './directory-watch-import.ts';

export const AGENT_IMPORT_ROOTS_KEY = 'AGENT_IMPORT_ROOTS';

function parseAuthorizedRoots(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function appendAgentImportRoot(raw: string, root: string): string {
  const clean = root.trim();
  if (!clean || /[\r\n,]/.test(clean)) throw new Error('The selected directory name must not contain commas or line breaks');
  return [...new Set([...parseAuthorizedRoots(raw), clean])].join(',');
}

/** Whether a requested path sits inside one of the configured import
 *  roots. Extracted for the check; uses the same containment semantics as
 *  watched folders. */
export function pathAllowedByRoots(roots: readonly string[], path: string): boolean {
  return roots.some((root) => isPathInside(root, path));
}

function authorizedRoots(): readonly string[] {
  return parseAuthorizedRoots(getKey(AGENT_IMPORT_ROOTS_KEY as never));
}

async function canonicalRoots(roots: readonly string[]): Promise<string[]> {
  const resolved = await Promise.all(roots.map((root) => realpath(root).catch(() => null)));
  return resolved.filter((root): root is string => root !== null);
}

function outsideRootsError(path: string, roots: readonly string[]): AgentPathImportError {
  return {
    path,
    code: 'PATH_OUTSIDE_IMPORT_ROOTS',
    error: `该路径不在已添加的本地素材目录中。已添加的目录：${roots.join(', ')}`,
  };
}

let callerSuppliedPathsTrusted = false;

/**
 * For the `occ` command line only: a path the user typed in their own terminal
 * is their explicit choice, so folder grants do not apply (unsafe path shapes
 * are still refused). The desktop app and the MCP server never call this.
 */
export function trustCallerSuppliedLocalPaths(): void {
  callerSuppliedPathsTrusted = true;
}

export async function resolveAgentMediaPath(path: string): Promise<string> {
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('path must be an absolute local path');
  const unsafe = unsafeLocalPathReason(path);
  if (unsafe) {
    // UNC / device / alternate-stream paths would make the OS contact a
    // network share or open a device before any containment check runs.
    audit({ event: 'path.rejected', capability: 'FILES_READ', action: 'agent.local-path', target: path, detail: unsafe });
    throw Object.assign(new Error(`path is not allowed (${unsafe})`), { code: 'UNSAFE_PATH' });
  }
  if (callerSuppliedPathsTrusted) return realpath(path);
  const configuredRoots = authorizedRoots();
  if (!configuredRoots.length) {
    throw Object.assign(
      new Error('No local media folder has been granted to the agent yet. Ask the user to choose a folder.'),
      { code: 'IMPORT_ROOTS_NOT_CONFIGURED' },
    );
  }
  const roots = await canonicalRoots(configuredRoots);
  if (!pathAllowedByRoots(configuredRoots, path) && !pathAllowedByRoots(roots, path)) {
    const error = outsideRootsError(path, configuredRoots);
    throw Object.assign(new Error(error.error), { code: error.code });
  }
  const canonicalPath = await realpath(path);
  if (!pathAllowedByRoots(roots, canonicalPath)) {
    const error = outsideRootsError(path, configuredRoots);
    throw Object.assign(new Error(error.error), { code: error.code });
  }
  return canonicalPath;
}

interface CandidatePlan {
  readonly path: string;
  readonly name: string;
  readonly root: string;
}

async function planCandidates(paths: readonly string[]): Promise<{
  candidates: CandidatePlan[];
  errors: AgentPathImportError[];
}> {
  const candidates: CandidatePlan[] = [];
  const errors: AgentPathImportError[] = [];
  for (const path of paths) {
    let canonicalPath: string;
    let info;
    try {
      canonicalPath = await resolveAgentMediaPath(path);
      info = await stat(canonicalPath);
    } catch (error) {
      errors.push({ path, error: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && 'code' in error
          && (error.code === 'PATH_OUTSIDE_IMPORT_ROOTS' || error.code === 'IMPORT_ROOTS_NOT_CONFIGURED')
          ? { code: error.code as 'PATH_OUTSIDE_IMPORT_ROOTS' | 'IMPORT_ROOTS_NOT_CONFIGURED' } : {}),
      });
      continue;
    }
    if (info.isDirectory()) {
      try {
        const scanned = await scanImportDirectory(canonicalPath, {
          readdir: (dir) => readdir(dir, { withFileTypes: true }) as Promise<Dirent[]>,
        });
        for (const candidate of scanned) {
          candidates.push({ path: candidate.path, name: candidate.name, root: canonicalPath });
        }
      } catch (error) {
        errors.push({ path, error: error instanceof Error ? error.message : String(error) });
      }
    } else if (info.isFile()) {
      // The media kind comes from the file that is actually read, so a link
      // named "x.svg" cannot smuggle an arbitrary target in as an image.
      candidates.push({ path: canonicalPath, name: basename(canonicalPath), root: dirname(canonicalPath) });
    } else {
      errors.push({ path, error: 'not a file or directory' });
    }
  }
  return { candidates, errors };
}

/** One-shot import of agent-requested paths. Imported entries return without
 * importId; the browser side stamps the id when it converts to a pool asset. */
export async function importAgentPaths(
  request: AgentPathImportRequest,
): Promise<AgentPathImportResult> {
  const { candidates, errors } = await planCandidates(request.paths);
  const imported: Array<Omit<DirectoryImportedFile, 'importId'>> = [];
  const unsupportedFiles: string[] = [];
  let duplicateCount = 0;
  const knownHashes = new Set(request.knownHashes);
  const pinnedUploadDirectory = await canonicalCurrentUploadDirectory();
  for (const candidate of candidates) {
    const candidateRequest: DirectoryCandidateRequest = {
      sourcePath: candidate.path,
      root: candidate.root,
      name: candidate.name,
      pinnedUploadDirectory,
      knownHashes,
      cancelled: () => false,
      signal: new AbortController().signal,
    };
    try {
      const result = await importDirectoryCandidate(candidateRequest);
      if (result.status === 'imported') {
        imported.push(result.prepared.file);
        knownHashes.add(result.prepared.file.contentHash);
      } else if (result.status === 'retry') {
        errors.push({ path: candidate.path, error: 'import failed and can be retried' });
      } else if (result.status === 'unsupported') {
        unsupportedFiles.push(candidate.name);
      } else {
        duplicateCount += 1;
      }
    } catch (error) {
      errors.push({ path: candidate.path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { imported, errors, unsupportedFiles, duplicateCount };
}

interface AgentPathImportGrantDependencies {
  readonly chooseRoot: (requestedPath: string) => Promise<string | null>;
  readonly readRoots: () => string;
  readonly writeRoots: (roots: string) => Promise<void>;
  readonly runImport?: typeof importAgentPaths;
}

export async function importAgentPathsWithGrant(
  request: AgentPathImportRequest,
  dependencies: AgentPathImportGrantDependencies,
): Promise<AgentPathImportResult> {
  const runImport = dependencies.runImport ?? importAgentPaths;
  const first = await runImport(request);
  const grant = first.imported.length === 0
    ? first.errors.find((error) => error.code === 'IMPORT_ROOTS_NOT_CONFIGURED'
      || error.code === 'PATH_OUTSIDE_IMPORT_ROOTS')
    : undefined;
  if (!grant) return first;
  const root = await dependencies.chooseRoot(grant.path);
  if (!root) return first;
  await dependencies.writeRoots(appendAgentImportRoot(dependencies.readRoots(), root));
  return runImport(request);
}
