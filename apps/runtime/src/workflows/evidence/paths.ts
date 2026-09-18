/**
 * Worktree-relative path safety for `file` captures, in two deliberately separate stages.
 *
 * The split is load-bearing, not tidiness. The syntactic stage runs *before* the call position is
 * claimed, so an author typo leaves no `intended` row. The filesystem stage runs only on the
 * dispatch branch, so a capture that was already recorded is reused without the file having to
 * still exist — the whole point of capturing being that the evidence outlives its source.
 */

import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, posix, sep } from 'node:path';

import { Effect } from 'effect';

export interface EvidencePathError {
  readonly reason: 'path_outside_worktree' | 'path_not_found' | 'not_a_file';
}

/**
 * Reduce an author's path to the one spelling that enters the fingerprint and the record.
 *
 * Syntactic only — nothing here touches a disk. The returned form is what `source_path` stores, so
 * the record says what the author *named*, while the bytes come from whatever that name resolved
 * to. Recording the resolved path instead would quietly turn a symlink into the author's stated
 * intent.
 */
export function normalizeWorktreeRelativePath(
  candidate: string,
): { ok: true; path: string } | { ok: false; reason: 'path_outside_worktree' } {
  const outside = { ok: false, reason: 'path_outside_worktree' } as const;
  if (typeof candidate !== 'string' || candidate.length === 0) return outside;
  if (candidate.includes('\0')) return outside;
  if (isAbsolute(candidate)) return outside;
  // Checked explicitly rather than left to `isAbsolute`, which is platform-dependent: `/x` and
  // `C:\x` are both absolute on Windows and neither is on Linux, and a rule about what an author
  // may name must not change with the machine the runtime happens to run on.
  if (candidate.startsWith('/') || candidate.startsWith('\\')) return outside;
  if (/^[A-Za-z]:/.test(candidate)) return outside;

  // A trailing separator is dropped before the emptiness check, because `posix.normalize` keeps it:
  // `'./'` normalises to `'./'`, not to `'.'`, and would otherwise reach the filesystem stage as a
  // directory rather than being refused here, before a call position is claimed.
  const normalized = posix.normalize(candidate.replaceAll('\\', '/')).replace(/\/+$/, '');
  if (normalized === '' || normalized === '.') return outside;
  if (normalized === '..' || normalized.startsWith('../')) return outside;
  return { ok: true, path: normalized };
}

/**
 * Resolve a syntactically clean relative path to real bytes inside the worktree.
 *
 * Both ends are realpath-ed before they are compared, which is the lesson
 * `persistence/data-directory.service.ts` already had to learn: a `..`-free relative path can still
 * leave the worktree through a symlink, and comparing unresolved spellings would not notice. The
 * prefix test uses `root + sep` so a sibling directory whose name merely starts with the root's
 * name is not mistaken for something inside it.
 */
export function resolveWithinWorktree(
  worktreePath: string,
  relativePath: string,
): Effect.Effect<{ absolute: string }, EvidencePathError> {
  return Effect.gen(function* () {
    const root = yield* Effect.tryPromise({
      try: () => realpath(worktreePath),
      catch: () => ({ reason: 'path_outside_worktree' }) as EvidencePathError,
    });
    const absolute = yield* Effect.tryPromise({
      try: () => realpath(join(worktreePath, relativePath)),
      catch: () => ({ reason: 'path_not_found' }) as EvidencePathError,
    });
    if (absolute !== root && !absolute.startsWith(root.endsWith(sep) ? root : root + sep)) {
      return yield* Effect.fail({ reason: 'path_outside_worktree' } as EvidencePathError);
    }
    const stats = yield* Effect.tryPromise({
      try: () => stat(absolute),
      catch: () => ({ reason: 'path_not_found' }) as EvidencePathError,
    });
    // `stat`, not `lstat`: the path was already realpath-ed, so a symlink has been followed to its
    // target and containment was checked against that target. What matters here is only that the
    // thing at the end is a file whose bytes can be streamed, not a directory or a device.
    if (!stats.isFile()) return yield* Effect.fail({ reason: 'not_a_file' } as EvidencePathError);
    return { absolute };
  });
}
