/**
 * Region collection: walking each declared scope and publishing its regular files.
 *
 * Names come from directory listings, so every collected path is the exact spelling the directory
 * entries carry. Links, special files and anything named `.git` are never entered or read; each is
 * recorded as a region warning instead, which also protects its path from ever becoming an absence.
 *
 * Bytes are read through a held, verified handle rather than by pathname: `lstat`, confirm the
 * pathname still resolves to itself, open without following links, `fstat` for the same inode,
 * stream into the content store while hashing the Git blob id, then `fstat` and `lstat` again. A
 * file that changed, moved or was swapped anywhere in that sequence refuses the capture. This does
 * not promise an atomic snapshot; it promises that observable instability never becomes a
 * successful checkpoint. The directories themselves are revalidated later by the capture service,
 * after every other filesystem-dependent read, so they all sit inside one bracket.
 */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';

import { Effect } from 'effect';

import type { DatabaseError } from '../../persistence/index.js';
import {
  resolveScopeRoot,
  type DirectorySnapshot,
  type EntryStat,
  type ScopeRootError,
} from '../paths.js';
import type { WorkflowContentStoreService } from '../persistence/content-store.js';
import { CheckpointCaptureFailure } from './failure.js';
import { pathContains, type NormalizedScope } from './plan.js';
import { compareBytes, regionContains, type Region } from './resolve.js';
import type { CollectedFile, CollectedRegion, RegionWarning } from './types.js';

export interface CollectRegionsInput {
  /** The realpath-ed worktree root. */
  readonly root: string;
  readonly scopes: readonly NormalizedScope[];
  /** The parent's coverage: a missing root inside it is an intentional empty recapture. */
  readonly parentCoverage: readonly Region[];
  /** Plan roots with at least one base entry under their exact spelling: a deletion declared under Git's spelling. */
  readonly baseTrackedRoots: ReadonlySet<string>;
  /** Null for a folder project, which has no base to compare object ids with. */
  readonly objectFormat: 'sha1' | 'sha256' | null;
  readonly content: WorkflowContentStoreService;
  readonly snapshot: DirectorySnapshot;
  /** Told of every reference as soon as its bytes are durable, so a later refusal can name its orphans. */
  readonly onPublished: (contentRef: string) => void;
}

const errnoOf = (cause: unknown) => (cause as { code?: unknown } | null)?.code;
const isNotFound = (cause: unknown) => errnoOf(cause) === 'ENOENT' || errnoOf(cause) === 'ENOTDIR';

function unstable(path: string, message: string, cause?: unknown) {
  return new CheckpointCaptureFailure({ reason: 'unstable_capture', message, path, cause });
}

function inspectionFailed(path: string, cause: unknown) {
  return new CheckpointCaptureFailure({
    reason: 'path_inspection_failed',
    message: `Could not inspect ${path}.`,
    path,
    cause,
  });
}

function fromScopeRootError(scope: NormalizedScope, error: ScopeRootError) {
  const messages: Record<ScopeRootError['reason'], string> = {
    scope_root_is_symlink: `Scope ${scope.scopeId} passes through a symbolic link at ${error.path}.`,
    scope_kind_mismatch: `Scope ${scope.scopeId} expects a ${scope.kind} but ${error.path} is not one.`,
    scope_path_spelling_mismatch: `Scope ${scope.scopeId} names ${error.path}, which exists under a different spelling.`,
    unstable_capture: `Scope ${scope.scopeId} changed while it was being inspected at ${error.path}.`,
    path_inspection_failed: `Could not inspect ${error.path} for scope ${scope.scopeId}.`,
  };
  return new CheckpointCaptureFailure({
    reason: error.reason,
    message: messages[error.reason],
    path: error.path,
    scopeId: scope.scopeId,
    cause: error.cause,
  });
}

export function collectRegions(
  input: CollectRegionsInput,
): Effect.Effect<readonly CollectedRegion[], CheckpointCaptureFailure | DatabaseError> {
  return Effect.forEach(input.scopes, (scope) => collectRegion(input, scope));
}

function collectRegion(
  input: CollectRegionsInput,
  scope: NormalizedScope,
): Effect.Effect<CollectedRegion, CheckpointCaptureFailure | DatabaseError> {
  return Effect.gen(function* () {
    const resolution = yield* resolveScopeRoot(
      input.snapshot,
      input.root,
      scope.path,
      scope.kind,
      scope.exclusions,
    ).pipe(Effect.mapError((error) => fromScopeRootError(scope, error)));

    if (resolution.kind === 'alias') {
      return yield* new CheckpointCaptureFailure({
        reason: 'scope_path_spelling_mismatch',
        message: `Scope ${scope.scopeId} names ${scope.path}, which exists under a different spelling.`,
        path: scope.path,
        scopeId: scope.scopeId,
      });
    }
    if (resolution.kind === 'absent') {
      const covered = input.parentCoverage.some((region) => regionContains(region, scope.path));
      if (!covered && !input.baseTrackedRoots.has(scope.path)) {
        return yield* new CheckpointCaptureFailure({
          reason: 'scope_path_not_found',
          message: `Scope ${scope.scopeId} names ${scope.path}, which does not exist and was neither captured before nor tracked by the base commit.`,
          path: scope.path,
          scopeId: scope.scopeId,
        });
      }
      return { scope, absoluteRoot: null, files: [], warnings: [] };
    }

    const files: CollectedFile[] = [];
    const warnings: RegionWarning[] = [];
    const warn = (reason: RegionWarning['reason'], path: string) =>
      warnings.push({ reason, path, scopeId: scope.scopeId });

    if (scope.kind === 'file') {
      const entry = yield* lstatEntry(input.snapshot, resolution.absolute, scope.path);
      // `resolveScopeRoot` just saw a regular file here.
      if (entry.kind !== 'file') {
        return yield* unstable(scope.path, `${scope.path} changed while it was being captured.`);
      }
      files.push(yield* collectFile(input, resolution.absolute, scope.path, entry));
      return { scope, absoluteRoot: resolution.absolute, files, warnings };
    }

    const excluded = (path: string) =>
      scope.exclusions.some((exclusion) => pathContains(`${scope.path}/${exclusion}`, path));

    const walk = (
      absolute: string,
      relative: string,
    ): Effect.Effect<void, CheckpointCaptureFailure | DatabaseError> =>
      Effect.gen(function* () {
        const observed = yield* input.snapshot
          .observe(absolute, { fatal: true })
          .pipe(Effect.mapError((error) => inspectionFailed(relative, error.cause)));
        // Only entered because a `lstat` a moment ago said directory; anything else is a replacement.
        if (observed.kind !== 'directory') {
          return yield* unstable(relative, `${relative} was replaced while it was being captured.`);
        }
        for (const name of [...observed.names].sort(compareBytes)) {
          const childRelative = `${relative}/${name}`;
          if (excluded(childRelative)) continue;
          if (name === '.git') {
            warn('nested_repository_skipped', childRelative);
            continue;
          }
          const childAbsolute = join(absolute, name);
          const entry = yield* lstatEntry(input.snapshot, childAbsolute, childRelative);
          switch (entry.kind) {
            case 'symlink':
              warn('symlink_skipped', childRelative);
              break;
            case 'other':
              warn('special_file_skipped', childRelative);
              break;
            case 'directory':
              yield* walk(childAbsolute, childRelative);
              break;
            case 'file':
              files.push(yield* collectFile(input, childAbsolute, childRelative, entry));
              break;
          }
        }
      });

    yield* walk(resolution.absolute, scope.path);
    return { scope, absoluteRoot: resolution.absolute, files, warnings };
  });
}

/** A listed entry that is no longer there was removed during the walk: instability, not absence. */
function lstatEntry(snapshot: DirectorySnapshot, absolute: string, relative: string) {
  return Effect.tryPromise({
    try: () => snapshot.reader.lstat(absolute),
    catch: (cause) =>
      isNotFound(cause)
        ? unstable(relative, `${relative} disappeared while it was being captured.`, cause)
        : inspectionFailed(relative, cause),
  });
}

/**
 * Publish one regular file through a held, verified handle, returning the facts the fold needs.
 * `before` is the walk's own `lstat` of the pathname.
 */
function collectFile(
  input: CollectRegionsInput,
  absolute: string,
  relative: string,
  before: EntryStat,
): Effect.Effect<CollectedFile, CheckpointCaptureFailure | DatabaseError> {
  const changed = (what: string) =>
    unstable(relative, `${relative} changed while it was being captured (${what}).`);

  return Effect.gen(function* () {
    // The walk joined verbatim names onto a realpath-ed root, so any difference means an ancestor
    // became a link after the walk entered it.
    const real = yield* Effect.tryPromise({
      try: () => input.snapshot.reader.realpath(absolute),
      catch: (cause) =>
        isNotFound(cause)
          ? unstable(relative, `${relative} disappeared while it was being captured.`, cause)
          : inspectionFailed(relative, cause),
    });
    if (real !== absolute) return yield* changed('its path now resolves elsewhere');

    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () =>
          open(
            absolute,
            constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
          ),
        catch: (cause) => {
          const code = errnoOf(cause);
          // A permission refusal is an inspection failure; a link or a vanished file is a change.
          return code === 'EACCES' || code === 'EPERM' || code === 'EIO'
            ? inspectionFailed(relative, cause)
            : unstable(relative, `${relative} could not be opened as the file it was.`, cause);
        },
      }),
      (handle) => publishFromHandle(input, handle, absolute, relative, before, changed),
      (handle) => Effect.tryPromise(() => handle.close()).pipe(Effect.ignore),
    );
  });
}

function publishFromHandle(
  input: CollectRegionsInput,
  handle: FileHandle,
  absolute: string,
  relative: string,
  before: EntryStat,
  changed: (what: string) => CheckpointCaptureFailure,
): Effect.Effect<CollectedFile, CheckpointCaptureFailure | DatabaseError> {
  const fstat = Effect.tryPromise({
    try: () => handle.stat(),
    catch: (cause) => inspectionFailed(relative, cause),
  });
  return Effect.gen(function* () {
    // The check that carries the guarantee where `O_NOFOLLOW` does not exist, and that closes the
    // window between the realpath and the open: a redirected open lands on a different inode.
    const opened = yield* fstat;
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      return yield* changed('a different file was opened');
    }

    const hash = input.objectFormat === null ? null : createHash(input.objectFormat);
    hash?.update(`blob ${before.size}\0`);
    // `autoClose: false` is load-bearing: the handle must still be open for the checks after the
    // store has consumed the stream.
    const stream = handle.createReadStream({ autoClose: false, start: 0 });
    const hasher = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash?.update(chunk);
        callback(null, chunk);
      },
    });
    stream.once('error', (cause) => hasher.destroy(cause));
    const published = yield* input.content
      .put({ source: stream.pipe(hasher), mediaTypeHint: 'application/octet-stream' })
      .pipe(
        Effect.catchTag('ContentPublishError', (cause) =>
          Effect.fail(
            new CheckpointCaptureFailure({
              reason: 'content_publish_failed',
              message: `Could not save the contents of ${relative}.`,
              path: relative,
              cause,
            }),
          ),
        ),
      );
    input.onPublished(published.contentRef);

    const after = yield* fstat;
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.mode !== before.mode ||
      published.byteSize !== before.size
    ) {
      return yield* changed('its size, modification time or mode moved');
    }
    const again = yield* Effect.tryPromise({
      try: () => input.snapshot.reader.lstat(absolute),
      catch: (cause) =>
        isNotFound(cause)
          ? unstable(relative, `${relative} disappeared while it was being captured.`, cause)
          : inspectionFailed(relative, cause),
    });
    if (again.dev !== before.dev || again.ino !== before.ino) {
      return yield* changed('the path now names another file');
    }

    return {
      path: relative,
      contentRef: published.contentRef,
      byteSize: published.byteSize,
      executable: (before.mode & 0o100) !== 0,
      objectId: hash === null ? null : hash.digest('hex'),
    };
  });
}
