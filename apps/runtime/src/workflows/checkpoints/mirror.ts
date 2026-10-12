import { createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, readdir, rm, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { Data, Effect } from 'effect';

import { errorMessage } from '../state/pure.js';
import type { CheckpointScope } from '../store/checkpoints.js';
import type { WorkflowContentStore } from '../store/content-store.js';
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

/**
 * A mirror step that failed. `path` names the captured file whose saved copy could not be read, and
 * is null when the destination's filesystem refused a step; `message` says what went wrong.
 */
export class CheckpointMirrorFailed extends Data.TaggedError('CheckpointMirrorFailed')<{
  readonly path: string | null;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const mirrorScopes = Effect.fn('workflows.mirrorScopes')(function* (
  root: string,
  scopes: readonly CheckpointScope[],
  content: WorkflowContentStore['Service'],
) {
  for (const scope of scopes) {
    if (scope.kind === 'directory') {
      yield* prune(root, scope, scope.path, new Set(scope.files.map((file) => file.path)));
    } else if (scope.missing) {
      yield* removeFile(root, scope.path);
    }
    for (const file of scope.files) {
      yield* writeCapturedFile(root, file, content);
    }
  }
});

/**
 * Deletes regular files under `directory` that are not in `keep` and not excluded. Returns whether
 * the directory is now absent. A directory that had something deleted beneath it and is left empty
 * is removed; one that was already empty is left alone.
 */
const prune: (
  root: string,
  scope: CheckpointScope,
  directory: string,
  keep: ReadonlySet<string>,
) => Effect.Effect<boolean, CheckpointMirrorFailed> = Effect.fnUntraced(
  function* (root, scope, directory, keep) {
    if (directory === scope.path && !(yield* parentsAreDirectories(root, directory))) return true;
    const absolute = join(root, directory);
    const stats = yield* filesystem(() => lstatOrNull(absolute));
    if (stats === null) return true;
    if (!stats.isDirectory()) {
      // Inside the scope, a link or special file is left alone. At the scope root, capture saw a
      // directory or nothing, so whatever the commit has there is removed.
      if (directory !== scope.path) return false;
      yield* filesystem(() => unlink(absolute));
      return true;
    }

    let deleted = false;
    for (const entry of yield* filesystem(() => readdir(absolute, { withFileTypes: true }))) {
      const path = `${directory}/${entry.name}`;
      if (entry.name === '.git' || isExcluded(scope, path)) continue;
      if (entry.isDirectory()) {
        const removed = yield* prune(root, scope, path, keep);
        deleted ||= removed;
      } else if (entry.isFile() && !keep.has(path)) {
        yield* filesystem(() => unlink(join(root, path)));
        deleted = true;
      }
    }
    if (deleted && (yield* filesystem(() => readdir(absolute))).length === 0) {
      yield* filesystem(() => rmdir(absolute));
      return true;
    }
    return false;
  },
);

/** A file scope captured as missing: capture saw nothing at that path, so nothing stays there. */
const removeFile = Effect.fnUntraced(function* (root: string, path: string) {
  if (!(yield* parentsAreDirectories(root, path))) return;
  yield* removeEntry(root, path);
});

const writeCapturedFile = Effect.fnUntraced(function* (
  root: string,
  file: CheckpointScope['files'][number],
  content: WorkflowContentStore['Service'],
) {
  const parts = file.path.split('/');
  for (let index = 1; index < parts.length; index += 1) {
    const relative = parts.slice(0, index).join('/');
    const stats = yield* filesystem(() => lstatOrNull(join(root, relative)));
    if (stats?.isDirectory()) continue;
    // Capture saw a directory here: a file or link the commit has in its place is replaced.
    if (stats !== null) yield* filesystem(() => unlink(join(root, relative)));
    yield* filesystem(() => mkdir(join(root, relative)));
  }
  // Capture saw a regular file here: whatever the commit has in its place is replaced.
  yield* removeEntry(root, file.path);

  const source = yield* content.open(`sha256:${file.sha256}`).pipe(
    Effect.catchTag('ContentUnavailable', (unavailable) =>
      Effect.fail(
        new CheckpointMirrorFailed({
          path: file.path,
          message: `The saved copy of '${file.path}' is ${unavailable.cause} in the content store.`,
          cause: unavailable,
        }),
      ),
    ),
  );
  const absolute = join(root, file.path);
  const mode = file.executable ? 0o755 : 0o644;
  // The signal tears the copy down when the export is interrupted.
  yield* filesystem((signal) =>
    pipeline(source, createWriteStream(absolute, { flags: 'wx', mode }), { signal }),
  ).pipe(Effect.onError(() => Effect.sync(() => source.destroy())));
  yield* filesystem(() => chmod(absolute, mode));
});

/** Removes whatever is at `path`: a directory with its contents, or the file or link itself. */
const removeEntry = Effect.fnUntraced(function* (root: string, path: string) {
  const stats = yield* filesystem(() => lstatOrNull(join(root, path)));
  if (stats === null) return;
  if (stats.isDirectory()) yield* filesystem(() => rm(join(root, path), { recursive: true }));
  else yield* filesystem(() => unlink(join(root, path)));
});

/**
 * Whether every parent of `path` is a real directory. When one is missing, a file or a link, the
 * path itself cannot exist without going through it, so there is nothing there to prune or delete.
 */
const parentsAreDirectories = Effect.fnUntraced(function* (root: string, path: string) {
  const parts = path.split('/');
  for (let index = 1; index < parts.length; index += 1) {
    const stats = yield* filesystem(() => lstatOrNull(join(root, parts.slice(0, index).join('/'))));
    if (stats === null || !stats.isDirectory()) return false;
  }
  return true;
});

/**
 * One filesystem step on the destination. A failure fails the mirror with the filesystem's own
 * description, as the export's error has always shown it.
 */
function filesystem<A>(
  step: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, CheckpointMirrorFailed> {
  return Effect.tryPromise({
    try: step,
    catch: (cause) =>
      new CheckpointMirrorFailed({ path: null, message: errorMessage(cause), cause }),
  });
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
