import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  type Stats,
} from 'node:fs';
import { basename, join } from 'node:path';

import { Data, Effect } from 'effect';

import { describeSafely, type SafeDiagnostic } from '../platform/diagnostics/index.js';

/**
 * Small filesystem boundary for the polling observer. It intentionally exposes
 * only discovery, identity, and byte-range reads; higher-level lifecycle state
 * stays in the observer.
 *
 * The filesystem calls are synchronous on purpose: every read is a bounded
 * `lstat` or byte range, repeated every observer poll, and an async round trip
 * per call would cost more than the read. Each entry point is one `Effect.try`,
 * so a source the observer cannot read is a typed, recoverable failure.
 */
export interface JsonlFileState {
  readonly path: string;
  readonly identity: string;
  readonly size: number;
}

/**
 * An observation source the observer could not read: it is a symbolic link or
 * not a regular file/directory, it vanished between two calls, or the
 * filesystem refused the read.
 */
export class HarnessSourceUnreadable
  extends Data.TaggedError('HarnessSourceUnreadable')<{
    readonly path: string;
    readonly reason: 'not_regular_file' | 'not_directory' | 'io' | 'disappeared';
    readonly cause: unknown;
  }>
  implements SafeDiagnostic
{
  // The path is deliberately left out: it is user data, and the observer logs it as its own field.
  [describeSafely]() {
    return { label: `Harness observation source unreadable (${this.reason})`, cause: this.cause };
  }
}

export function discoverJsonlFiles(
  directory: string,
): Effect.Effect<readonly string[], HarnessSourceUnreadable> {
  return Effect.flatMap(lstatOrMissing(directory), (stat) => {
    if (stat === null) return Effect.succeed([]);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return Effect.fail(unreadable(directory, 'not_directory', null));
    }
    return Effect.try({
      try: () =>
        readdirSync(directory, { withFileTypes: true })
          .filter((entry) => entry.isFile() && /^[^.]+\.harness\.jsonl$/.test(entry.name))
          .map((entry) => join(directory, entry.name))
          .sort((left, right) => basename(left).localeCompare(basename(right))),
      catch: (cause) =>
        isMissing(cause) ? unreadable(directory, 'disappeared', cause) : classify(directory, cause),
    }).pipe(
      // A directory removed between the `lstat` and the listing reads as empty, as a missing one does.
      Effect.catchTag('HarnessSourceUnreadable', (error) =>
        error.reason === 'disappeared' ? Effect.succeed([]) : Effect.fail(error),
      ),
    );
  });
}

export function jsonlFileState(
  path: string,
): Effect.Effect<JsonlFileState | null, HarnessSourceUnreadable> {
  return Effect.flatMap(lstatOrMissing(path), (stat) => {
    if (stat === null) return Effect.succeed(null);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return Effect.fail(unreadable(path, 'not_regular_file', null));
    }
    // ctime changes on every append, so it is not identity. Device/inode and
    // creation time stay stable across normal writes while detecting replacement.
    return Effect.succeed({
      path,
      identity: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`,
      size: stat.size,
    });
  });
}

export function readJsonlBytes(
  path: string,
  offset: number,
  length: number,
): Effect.Effect<Buffer, HarnessSourceUnreadable> {
  if (length <= 0) return Effect.succeed(Buffer.alloc(0));
  return Effect.try({
    try: () => readRange(path, offset, length),
    catch: (cause) => classify(path, cause),
  }).pipe(
    Effect.flatMap((bytes) =>
      bytes === null
        ? Effect.fail(unreadable(path, 'not_regular_file', null))
        : Effect.succeed(bytes),
    ),
  );
}

export function splitCompleteJsonlLines(input: Buffer): {
  readonly completeLines: readonly string[];
  readonly trailingBytes: Buffer;
} {
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < input.length; index += 1) {
    if (input[index] !== 0x0a) continue;
    const end = index > start && input[index - 1] === 0x0d ? index - 1 : index;
    lines.push(input.subarray(start, end).toString('utf8'));
    start = index + 1;
  }
  return { completeLines: lines, trailingBytes: input.subarray(start) };
}

/** The bytes in range, or `null` when the opened descriptor is not a regular file. */
function readRange(path: string, offset: number, length: number): Buffer | null {
  const fd = openSync(
    path,
    constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
  );
  try {
    if (!fstatSync(fd).isFile()) return null;
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buffer, 0, length, offset);
    return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

/** `lstat`, with a missing path as `null`. */
function lstatOrMissing(path: string): Effect.Effect<Stats | null, HarnessSourceUnreadable> {
  return Effect.try({
    try: () => {
      try {
        return lstatSync(path);
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
    catch: (cause) => classify(path, cause),
  });
}

function classify(path: string, cause: unknown): HarnessSourceUnreadable {
  // `O_NOFOLLOW` refuses a symbolic link with `ELOOP`.
  if (errorCode(cause) === 'ELOOP') return unreadable(path, 'not_regular_file', cause);
  if (isMissing(cause)) return unreadable(path, 'disappeared', cause);
  return unreadable(path, 'io', cause);
}

function unreadable(
  path: string,
  reason: HarnessSourceUnreadable['reason'],
  cause: unknown,
): HarnessSourceUnreadable {
  return new HarnessSourceUnreadable({ path, reason, cause });
}

function isMissing(error: unknown) {
  return errorCode(error) === 'ENOENT';
}

function errorCode(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
}
