import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, rename, rm, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';

import { Data, Effect, Exit } from 'effect';

import { streamContent } from '../content-stream.js';
import { causeText, CliFailure, errnoOf, writeFailure } from '../errors.js';
import type { AbsentEntry, FileEntry } from './plan.js';

/**
 * Applying a planned inventory under one export root: absences first, then files.
 *
 * Every path is walked one component at a time with `lstat`, so nothing is ever followed through a
 * symlink, and nothing outside the root is touched. Files are written to a private temp file beside
 * the target and renamed into place only once their size and sha256 match, so a target is either
 * absent, left as the baseline had it, or complete.
 */

/**
 * Called whenever the export itself creates an entry under the root: a directory, or a file renamed
 * into place. A directory-only export starts from an empty folder that nothing else writes into, so
 * "something was created" is exactly "the destination is non-empty".
 */
export type EntryCreated = () => void;

/**
 * Removes one absent path if the baseline has it, then removes each parent directory that removal
 * emptied (R5), walking up and stopping at the root. A Git checkout never holds an empty directory,
 * so leaving one would add state the checkpoint never had.
 *
 * A parent that is missing, a symlink, or not a directory means the path cannot exist under the
 * root, so the absence already holds; it is never followed. A directory at the path itself is a
 * conflict: an absence names one entry, never a tree.
 */
export function applyAbsence(root: string, absence: AbsentEntry): Effect.Effect<void, CliFailure> {
  return Effect.tryPromise({
    try: async () => {
      const segments = absence.path.split('/');
      for (let length = 1; length < segments.length; length += 1) {
        const parent = await lstatOrNull(join(root, ...segments.slice(0, length)));
        if (parent === null || !parent.isDirectory()) return;
      }
      const target = join(root, ...segments);
      const stats = await lstatOrNull(target);
      if (stats === null) return;
      if (stats.isDirectory()) throw new PathConflict({ path: absence.path, found: 'directory' });
      await unlink(target);

      for (let length = segments.length - 1; length >= 1; length -= 1) {
        try {
          await rmdir(join(root, ...segments.slice(0, length)));
        } catch (error) {
          const errno = errnoOf(error);
          if (errno === 'ENOTEMPTY' || errno === 'EEXIST') return;
          throw error;
        }
      }
    },
    catch: (cause) =>
      cause instanceof PathConflict
        ? CliFailure.of(
            'export_path_conflict',
            `${cause.path} must be absent, but the baseline has a directory there.`,
            { path: cause.path, found: cause.found },
          )
        : writeFailure(join(root, absence.path), cause),
  });
}

/**
 * Writes one file under the root.
 *
 * 1. Each parent component is created or accepted one at a time; a symlink or any other
 *    non-directory is refused (`export_path_unsafe`). `EEXIST` from a concurrent write of a sibling
 *    is accepted only once `lstat` shows a real directory.
 * 2. A directory at the target is `export_path_conflict`; a file or symlink there is replaced by the
 *    rename, which replaces the directory entry itself and never follows it.
 * 3. The content streams into `<parent>/.isagi-export-<uuid>.tmp` (created exclusively, mode 0600)
 *    through a check that aborts as soon as more bytes arrive than recorded, and that compares size
 *    and sha256 at the end (`content_integrity_mismatch`). The temp file is removed on any failure
 *    or interruption.
 * 4. The mode is set (only the owner-execute bit is recorded) and the temp file renamed onto the
 *    target.
 */
export function writeFile<R>(
  root: string,
  file: FileEntry,
  content: Effect.Effect<Response, CliFailure, R>,
  created: EntryCreated,
): Effect.Effect<void, CliFailure, R> {
  const segments = file.path.split('/');
  const parent = join(root, ...segments.slice(0, -1));
  const target = join(root, ...segments);
  return Effect.gen(function* () {
    yield* ensureParents(root, segments.slice(0, -1), file.path, created);

    const existing = yield* Effect.tryPromise({
      try: () => lstatOrNull(target),
      catch: (cause) => writeFailure(target, cause),
    });
    if (existing?.isDirectory()) {
      return yield* Effect.fail(
        CliFailure.of(
          'export_path_conflict',
          `${file.path} must be a file, but the baseline has a directory there.`,
          { path: file.path, found: 'directory' },
        ),
      );
    }

    const temp = join(parent, `.isagi-export-${randomUUID()}.tmp`);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () => open(temp, 'wx', 0o600),
            catch: (cause) => writeFailure(temp, cause),
          }),
          (opened, exit) =>
            Effect.promise(async () => {
              await opened.close().catch(() => undefined);
              if (Exit.isFailure(exit)) await rm(temp, { force: true }).catch(() => undefined);
            }),
        );
        const response = yield* content;
        yield* streamContent(response.body, handle.createWriteStream(), {
          end: true,
          through: integrityCheck(file),
        }).pipe(
          Effect.mapError((failure) => {
            switch (failure.side) {
              case 'transform':
                return failure.cause instanceof IntegrityMismatch
                  ? CliFailure.of(
                      'content_integrity_mismatch',
                      `The bytes received for ${file.path} do not match its recorded ${failure.cause.field}.`,
                      {
                        path: file.path,
                        fileId: file.fileId,
                        expectedBytes: file.sizeBytes,
                        expectedSha256: file.sha256,
                        receivedBytes: failure.cause.receivedBytes,
                      },
                    )
                  : writeFailure(temp, failure.cause);
              case 'source':
                return CliFailure.of(
                  'runtime_unreachable',
                  `The content stream for ${file.path} failed part-way.`,
                  { path: file.path, fileId: file.fileId, cause: causeText(failure.cause) },
                );
              case 'destination':
                return writeFailure(temp, failure.cause);
            }
          }),
        );
        yield* Effect.tryPromise({
          try: async () => {
            await chmod(temp, file.executable ? 0o755 : 0o644);
            await rename(temp, target);
          },
          catch: (cause) => writeFailure(target, cause),
        });
        created();
      }),
    );
  });
}

function ensureParents(
  root: string,
  segments: readonly string[],
  path: string,
  created: EntryCreated,
): Effect.Effect<void, CliFailure> {
  return Effect.tryPromise({
    try: async () => {
      for (let length = 1; length <= segments.length; length += 1) {
        const component = join(root, ...segments.slice(0, length));
        const stats = await lstatOrNull(component);
        if (stats === null) {
          try {
            await mkdir(component);
            created();
            continue;
          } catch (error) {
            if (errnoOf(error) !== 'EEXIST') throw error;
          }
          // A sibling's write created it first; accept it only if it is a real directory.
          const raced = await lstat(component);
          if (!raced.isDirectory()) throw new UnsafeComponent({ component });
          created();
          continue;
        }
        if (!stats.isDirectory()) throw new UnsafeComponent({ component });
      }
    },
    catch: (cause) =>
      cause instanceof UnsafeComponent
        ? CliFailure.of(
            'export_path_unsafe',
            `Writing ${path} would pass through ${cause.component}, which is not a real directory; nothing is written through it.`,
            { path, component: cause.component },
          )
        : writeFailure(join(root, ...segments), cause),
  });
}

/**
 * Passes bytes through while hashing and counting them. It fails as soon as more bytes arrive than
 * the file records, and at the end if the size or sha256 differ.
 */
function integrityCheck(file: FileEntry): Transform {
  const hash = createHash('sha256');
  let received = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.byteLength;
      if (received > file.sizeBytes) {
        callback(new IntegrityMismatch({ field: 'size', receivedBytes: received }));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      if (received !== file.sizeBytes) {
        callback(new IntegrityMismatch({ field: 'size', receivedBytes: received }));
      } else if (hash.digest('hex') !== file.sha256) {
        callback(new IntegrityMismatch({ field: 'sha256', receivedBytes: received }));
      } else {
        callback();
      }
    },
  });
}

class IntegrityMismatch extends Data.TaggedError('IntegrityMismatch')<{
  readonly field: 'size' | 'sha256';
  readonly receivedBytes: number;
}> {}

class PathConflict extends Data.TaggedError('PathConflict')<{
  readonly path: string;
  readonly found: 'directory';
}> {}

class UnsafeComponent extends Data.TaggedError('UnsafeComponent')<{
  readonly component: string;
}> {}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return null;
    throw error;
  }
}
