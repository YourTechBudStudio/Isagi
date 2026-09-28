import { createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, readdir, rm, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { Effect, Either } from 'effect';

import type { CheckpointScope } from '../store/checkpoints.js';
import type { WorkflowContentStoreService } from '../store/content-store.js';
import { isExcluded } from './capture.js';

/**
 * Making a destination's scopes match a checkpoint's copies exactly.
 *
 * The mirror touches only what capture looked at. In a directory scope it deletes each regular file
 * the copy does not have, unless it is excluded, then writes every captured file with its executable
 * bit. Symlinks, special files, nested `.git` and excluded paths are left alone, and a directory
 * emptied by those deletions is removed, so a scope captured as missing (mirrored as an empty copy)
 * ends up absent. A file scope captured as missing is deleted.
 *
 * Where the destination's shape differs from what capture saw at a path it looked at (the commit
 * has a file or a link where the checkout had a directory, or the reverse), the captured shape
 * wins: the other entry is removed and replaced. Nothing is ever written or deleted through a
 * symlink, because the commit it came from may point anywhere; a link is only ever removed itself.
 */

export class MirrorFailed extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

export async function mirrorScopes(
  root: string,
  scopes: readonly CheckpointScope[],
  content: WorkflowContentStoreService,
): Promise<void> {
  for (const scope of scopes) {
    if (scope.kind === 'directory') {
      await prune(root, scope, scope.path, new Set(scope.files.map((file) => file.path)));
    } else if (scope.missing) {
      await removeFile(root, scope.path);
    }
    for (const file of scope.files) {
      await writeCapturedFile(root, file, content);
    }
  }
}

/**
 * Deletes regular files under `directory` that are not in `keep` and not excluded. Returns whether
 * the directory is now absent. A directory that had something deleted beneath it and is left empty
 * is removed; one that was already empty is left alone.
 */
async function prune(
  root: string,
  scope: CheckpointScope,
  directory: string,
  keep: ReadonlySet<string>,
): Promise<boolean> {
  if (directory === scope.path && !(await parentsAreDirectories(root, directory))) return true;
  const absolute = join(root, directory);
  const stats = await lstatOrNull(absolute);
  if (stats === null) return true;
  if (!stats.isDirectory()) {
    // Inside the scope, a link or special file is left alone. At the scope root, capture saw a
    // directory or nothing, so whatever the commit has there is removed.
    if (directory !== scope.path) return false;
    await unlink(absolute);
    return true;
  }

  let deleted = false;
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.name === '.git' || isExcluded(scope, path)) continue;
    if (entry.isDirectory()) {
      const removed = await prune(root, scope, path, keep);
      deleted ||= removed;
    } else if (entry.isFile() && !keep.has(path)) {
      await unlink(join(root, path));
      deleted = true;
    }
  }
  if (deleted && (await readdir(absolute)).length === 0) {
    await rmdir(absolute);
    return true;
  }
  return false;
}

/** A file scope captured as missing: capture saw nothing at that path, so nothing stays there. */
async function removeFile(root: string, path: string): Promise<void> {
  if (!(await parentsAreDirectories(root, path))) return;
  await removeEntry(root, path);
}

async function writeCapturedFile(
  root: string,
  file: CheckpointScope['files'][number],
  content: WorkflowContentStoreService,
): Promise<void> {
  const parts = file.path.split('/');
  for (let index = 1; index < parts.length; index += 1) {
    const relative = parts.slice(0, index).join('/');
    const stats = await lstatOrNull(join(root, relative));
    if (stats?.isDirectory()) continue;
    // Capture saw a directory here: a file or link the commit has in its place is replaced.
    if (stats !== null) await unlink(join(root, relative));
    await mkdir(join(root, relative));
  }
  // Capture saw a regular file here: whatever the commit has in its place is replaced.
  await removeEntry(root, file.path);

  const opened = await Effect.runPromise(Effect.either(content.open(`sha256:${file.sha256}`)));
  if (Either.isLeft(opened)) {
    throw new MirrorFailed(
      file.path,
      `The saved copy of '${file.path}' is ${opened.left.cause} in the content store.`,
    );
  }
  const absolute = join(root, file.path);
  const mode = file.executable ? 0o755 : 0o644;
  await pipeline(opened.right, createWriteStream(absolute, { flags: 'wx', mode }));
  await chmod(absolute, mode);
}

/** Removes whatever is at `path`: a directory with its contents, or the file or link itself. */
async function removeEntry(root: string, path: string): Promise<void> {
  const stats = await lstatOrNull(join(root, path));
  if (stats === null) return;
  if (stats.isDirectory()) await rm(join(root, path), { recursive: true });
  else await unlink(join(root, path));
}

/**
 * Whether every parent of `path` is a real directory. When one is missing, a file or a link, the
 * path itself cannot exist without going through it, so there is nothing there to prune or delete.
 */
async function parentsAreDirectories(root: string, path: string): Promise<boolean> {
  const parts = path.split('/');
  for (let index = 1; index < parts.length; index += 1) {
    const stats = await lstatOrNull(join(root, parts.slice(0, index).join('/')));
    if (stats === null || !stats.isDirectory()) return false;
  }
  return true;
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
