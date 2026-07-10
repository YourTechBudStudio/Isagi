import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} from 'node:fs';
import { basename, join } from 'node:path';

/**
 * Small filesystem boundary for the polling observer. It intentionally exposes
 * only discovery, identity, and byte-range reads; higher-level lifecycle state
 * stays in the observer.
 */
export interface JsonlFileState {
  readonly path: string;
  readonly identity: string;
  readonly size: number;
}

export function discoverHarnessJsonlFiles(directory: string): readonly string[] {
  try {
    const directoryStat = lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error('Harness observation directory is not a real directory.');
    }
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^[^.]+\.harness\.jsonl$/.test(entry.name))
      .map((entry) => join(directory, entry.name))
      .sort((left, right) => basename(left).localeCompare(basename(right)));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

export function jsonlFileState(path: string): JsonlFileState | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Harness observation source is not a regular file.');
    }
    // ctime changes on every append, so it is not identity. Device/inode and
    // creation time stay stable across normal writes while detecting replacement.
    return { path, identity: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`, size: stat.size };
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export function readJsonlBytes(path: string, offset: number, length: number): Buffer {
  if (length <= 0) return Buffer.alloc(0);
  const fd = openSync(
    path,
    constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
  );
  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error('Harness observation source is not a regular file.');
    }
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buffer, 0, length, offset);
    return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
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

function isMissing(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  );
}
