import { createReadStream, type Dirent } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { Effect, Either } from 'effect';

import type { WorkflowCheckpointFileDto } from '@isagi/contracts';

import { errorMessage } from '../state/pure.js';
import type { CheckpointScope } from '../store/checkpoints.js';
import type { WorkflowContentStoreService } from '../store/content-store.js';
import { pathContains, type NormalizedScope } from './plan.js';

/**
 * Copying a checkpoint's scopes out of the checkout into the content store.
 *
 * Only regular files are copied. Symlinks, special files and nested `.git` entries are skipped, and
 * nothing is ever followed through a link: a scope path that passes through a symlink fails the
 * capture rather than copying something outside the checkout. A scope whose path does not exist is
 * recorded as missing. Nothing here writes to the checkout.
 */

/** A capture failure the execution reports with stage `checkpoint_capture`. */
export class CaptureFailed extends Error {}

export function captureScopes(
  root: string,
  scopes: readonly NormalizedScope[],
  content: WorkflowContentStoreService,
): Effect.Effect<CheckpointScope[], CaptureFailed> {
  return Effect.tryPromise({
    try: async () => {
      const captured: CheckpointScope[] = [];
      for (const scope of scopes) captured.push(await captureScope(root, scope, content));
      return captured;
    },
    catch: (cause) =>
      cause instanceof CaptureFailed ? cause : new CaptureFailed(errorMessage(cause)),
  });
}

async function captureScope(
  root: string,
  scope: NormalizedScope,
  content: WorkflowContentStoreService,
): Promise<CheckpointScope> {
  const base = { scope: scope.scope, kind: scope.kind, path: scope.path, exclude: scope.exclude };
  const found = await locate(root, scope);
  if (found === 'missing') return { ...base, missing: true, files: [] };

  const files: WorkflowCheckpointFileDto[] = [];
  if (scope.kind === 'file') {
    files.push(await copyFile(root, scope.path, content));
  } else {
    await walk(root, scope, scope.path, files, content);
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  return { ...base, missing: false, files };
}

/**
 * Whether the scope's path exists, checked one component at a time without following links. A
 * parent that is not a directory means the path cannot exist, so it is missing.
 */
async function locate(root: string, scope: NormalizedScope): Promise<'present' | 'missing'> {
  const parts = scope.path.split('/');
  for (const index of parts.keys()) {
    const relative = parts.slice(0, index + 1).join('/');
    const stats = await lstatOrNull(join(root, relative));
    if (stats === null) return 'missing';
    if (stats.isSymbolicLink()) {
      throw new CaptureFailed(
        `Scope '${scope.scope}': '${relative}' is a symbolic link, which checkpoints never follow.`,
      );
    }
    const last = index === parts.length - 1;
    if (!last && !stats.isDirectory()) return 'missing';
    if (last && scope.kind === 'directory' && !stats.isDirectory()) {
      throw new CaptureFailed(`Scope '${scope.scope}': '${scope.path}' is not a directory.`);
    }
    if (last && scope.kind === 'file' && !stats.isFile()) {
      throw new CaptureFailed(`Scope '${scope.scope}': '${scope.path}' is not a regular file.`);
    }
  }
  return 'present';
}

async function walk(
  root: string,
  scope: NormalizedScope,
  directory: string,
  files: WorkflowCheckpointFileDto[],
  content: WorkflowContentStoreService,
): Promise<void> {
  const entries: Dirent[] = await readdir(join(root, directory), { withFileTypes: true });
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.name === '.git' || isExcluded(scope, path)) continue;
    if (entry.isDirectory()) await walk(root, scope, path, files, content);
    else if (entry.isFile()) files.push(await copyFile(root, path, content));
    // Symlinks and special files are skipped.
  }
}

/** Whether a root-relative path is an exclusion of this scope, or lies beneath one. */
export function isExcluded(scope: Pick<NormalizedScope, 'path' | 'exclude'>, path: string) {
  return scope.exclude.some((exclusion) => pathContains(`${scope.path}/${exclusion}`, path));
}

async function copyFile(
  root: string,
  path: string,
  content: WorkflowContentStoreService,
): Promise<WorkflowCheckpointFileDto> {
  const absolute = join(root, path);
  const stats = await lstat(absolute);
  const put = await Effect.runPromise(
    Effect.either(content.put({ source: createReadStream(absolute) })),
  );
  if (Either.isLeft(put)) throw new CaptureFailed(`Could not save '${path}': ${put.left.message}`);
  const stored = put.right;
  return {
    path,
    sha256: stored.contentRef.slice('sha256:'.length),
    sizeBytes: stored.byteSize,
    executable: (stats.mode & 0o100) !== 0,
  };
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
