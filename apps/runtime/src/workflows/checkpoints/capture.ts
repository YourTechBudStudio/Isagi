import { createReadStream, type Dirent } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { Data, Effect } from 'effect';

import type { WorkflowCheckpointFileDto } from '@isagi/contracts';

import { errorMessage } from '../state/pure.js';
import type { CheckpointScope } from '../store/checkpoints.js';
import type { ContentCapture } from '../store/content-store.js';
import { pathContains, type NormalizedScope } from './plan.js';

/**
 * Copying a checkpoint's scopes out of the checkout into the content store, through one capture
 * lease, so everything copied stays protected from the content collector until the caller's
 * checkpoint row has committed.
 *
 * Only regular files are copied. Symlinks, special files and nested `.git` entries are skipped, and
 * nothing is ever followed through a link: a scope path that passes through a symlink fails the
 * capture rather than copying something outside the checkout. A scope whose path does not exist is
 * recorded as missing. Nothing here writes to the checkout.
 */

/**
 * A capture failure the execution reports with stage `checkpoint_capture`. `message` is what the
 * run's error shows; `cause` is the filesystem or content-store failure behind it, when there is one.
 */
export class CheckpointCaptureFailed extends Data.TaggedError('CheckpointCaptureFailed')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const captureScopes = Effect.fn('workflows.captureScopes')(function* (
  root: string,
  scopes: readonly NormalizedScope[],
  capture: ContentCapture,
) {
  const captured: CheckpointScope[] = [];
  for (const scope of scopes) captured.push(yield* captureScope(root, scope, capture));
  return captured;
});

const captureScope = Effect.fnUntraced(function* (
  root: string,
  scope: NormalizedScope,
  capture: ContentCapture,
) {
  const base = { scope: scope.scope, kind: scope.kind, path: scope.path, exclude: scope.exclude };
  const found = yield* locate(root, scope);
  if (found === 'missing') {
    const missing: CheckpointScope = { ...base, missing: true, files: [] };
    return missing;
  }

  const files: WorkflowCheckpointFileDto[] = [];
  if (scope.kind === 'file') {
    files.push(yield* copyFile(root, scope.path, capture));
  } else {
    yield* walk(root, scope, scope.path, files, capture);
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  const present: CheckpointScope = { ...base, missing: false, files };
  return present;
});

/**
 * Whether the scope's path exists, checked one component at a time without following links. A
 * parent that is not a directory means the path cannot exist, so it is missing.
 */
const locate = Effect.fnUntraced(function* (root: string, scope: NormalizedScope) {
  const parts = scope.path.split('/');
  for (const index of parts.keys()) {
    const relative = parts.slice(0, index + 1).join('/');
    const stats = yield* filesystem(() => lstatOrNull(join(root, relative)));
    if (stats === null) return 'missing' as const;
    if (stats.isSymbolicLink()) {
      return yield* new CheckpointCaptureFailed({
        message: `Scope '${scope.scope}': '${relative}' is a symbolic link, which checkpoints never follow.`,
      });
    }
    const last = index === parts.length - 1;
    if (!last && !stats.isDirectory()) return 'missing' as const;
    if (last && scope.kind === 'directory' && !stats.isDirectory()) {
      return yield* new CheckpointCaptureFailed({
        message: `Scope '${scope.scope}': '${scope.path}' is not a directory.`,
      });
    }
    if (last && scope.kind === 'file' && !stats.isFile()) {
      return yield* new CheckpointCaptureFailed({
        message: `Scope '${scope.scope}': '${scope.path}' is not a regular file.`,
      });
    }
  }
  return 'present' as const;
});

const walk: (
  root: string,
  scope: NormalizedScope,
  directory: string,
  files: WorkflowCheckpointFileDto[],
  capture: ContentCapture,
) => Effect.Effect<void, CheckpointCaptureFailed> = Effect.fnUntraced(
  function* (root, scope, directory, files, capture) {
    const entries: Dirent[] = yield* filesystem(() =>
      readdir(join(root, directory), { withFileTypes: true }),
    );
    for (const entry of entries) {
      const path = `${directory}/${entry.name}`;
      if (entry.name === '.git' || isExcluded(scope, path)) continue;
      if (entry.isDirectory()) yield* walk(root, scope, path, files, capture);
      else if (entry.isFile()) files.push(yield* copyFile(root, path, capture));
      // Symlinks and special files are skipped.
    }
  },
);

/** Whether a root-relative path is an exclusion of this scope, or lies beneath one. */
export function isExcluded(scope: Pick<NormalizedScope, 'path' | 'exclude'>, path: string) {
  return scope.exclude.some((exclusion) => pathContains(`${scope.path}/${exclusion}`, path));
}

const copyFile = Effect.fnUntraced(function* (root: string, path: string, capture: ContentCapture) {
  const absolute = join(root, path);
  const stats = yield* filesystem(() => lstat(absolute));
  const stored = yield* capture.put({ source: createReadStream(absolute) }).pipe(
    Effect.catchTag('ContentPublishError', (error) =>
      Effect.fail(
        new CheckpointCaptureFailed({
          message: `Could not save '${path}': ${error.message}`,
          cause: error,
        }),
      ),
    ),
  );
  const file: WorkflowCheckpointFileDto = {
    path,
    sha256: stored.contentRef.slice('sha256:'.length),
    sizeBytes: stored.byteSize,
    executable: (stats.mode & 0o100) !== 0,
  };
  return file;
});

/**
 * One filesystem read of the checkout. A failure fails the capture with the filesystem's own
 * description, as the run's error has always shown it.
 */
function filesystem<A>(read: () => Promise<A>): Effect.Effect<A, CheckpointCaptureFailed> {
  return Effect.tryPromise({
    try: read,
    catch: (cause) => new CheckpointCaptureFailed({ message: errorMessage(cause), cause }),
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
