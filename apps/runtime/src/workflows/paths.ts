/**
 * Worktree-relative path safety, shared by the evidence verb and checkpoint capture so the two
 * capture paths cannot drift.
 *
 * Evidence uses two deliberately separate stages. The split is load-bearing, not tidiness. The
 * syntactic stage runs *before* the call position is claimed, so an author typo leaves no
 * `intended` row. The filesystem stage runs only on the dispatch branch, so a capture that was
 * already recorded is reused without the file having to still exist — the whole point of capturing
 * being that the evidence outlives its source.
 *
 * Checkpoints need more than "resolve to a file": they must tell an absent root from an unreadable
 * one, name every entry by its directory-entry spelling on filesystems that fold case or Unicode,
 * never enter a link, and notice when a directory they relied on was replaced. That is the second
 * half of this module, built around one `DirectorySnapshot` per capture.
 */

import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, posix, sep } from 'node:path';

import { Data, Effect } from 'effect';

export interface WorktreePathError {
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
): Effect.Effect<{ absolute: string }, WorktreePathError> {
  return Effect.gen(function* () {
    const root = yield* Effect.tryPromise({
      try: () => realpath(worktreePath),
      catch: () => ({ reason: 'path_outside_worktree' }) as WorktreePathError,
    });
    const absolute = yield* Effect.tryPromise({
      try: () => realpath(join(worktreePath, relativePath)),
      catch: () => ({ reason: 'path_not_found' }) as WorktreePathError,
    });
    if (absolute !== root && !absolute.startsWith(root.endsWith(sep) ? root : root + sep)) {
      return yield* Effect.fail({ reason: 'path_outside_worktree' } as WorktreePathError);
    }
    const stats = yield* Effect.tryPromise({
      try: () => stat(absolute),
      catch: () => ({ reason: 'path_not_found' }) as WorktreePathError,
    });
    // `stat`, not `lstat`: the path was already realpath-ed, so a symlink has been followed to its
    // target and containment was checked against that target. What matters here is only that the
    // thing at the end is a file whose bytes can be streamed, not a directory or a device.
    if (!stats.isFile()) return yield* Effect.fail({ reason: 'not_a_file' } as WorktreePathError);
    return { absolute };
  });
}

// ---------------------------------------------------------------------------------------------
// Checkpoint path identity and directory observation.
// ---------------------------------------------------------------------------------------------

/** What `lstat` found, reduced to the facts capture compares. Identity is `(dev, ino)`. */
export interface EntryStat {
  readonly kind: 'directory' | 'file' | 'symlink' | 'other';
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly mode: number;
}

/**
 * The only way checkpoint code reads names and identities from the filesystem.
 *
 * Injected so the case- and normalization-insensitive behaviour of the destination filesystem can
 * be tested on any host with a fake. Rejections carry the errno `code` of the underlying call.
 */
export interface DirectoryReader {
  readonly readdir: (absolute: string) => Promise<readonly string[]>;
  readonly lstat: (absolute: string) => Promise<EntryStat>;
  readonly realpath: (absolute: string) => Promise<string>;
}

export const nodeDirectoryReader: DirectoryReader = {
  readdir: (absolute) => readdir(absolute),
  lstat: async (absolute) => {
    const stats = await lstat(absolute);
    return {
      kind: stats.isDirectory()
        ? 'directory'
        : stats.isFile()
          ? 'file'
          : stats.isSymbolicLink()
            ? 'symlink'
            : 'other',
      dev: stats.dev,
      ino: stats.ino,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      mode: stats.mode,
    };
  },
  realpath: (absolute) => realpath(absolute),
};

/**
 * An actual I/O or permission error (`EACCES`, `EIO`, …). Never used for not-found, which is typed
 * data everywhere below: a permission error under covered state must not read as a deletion.
 */
export class PathInspectionError extends Data.TaggedError('PathInspectionError')<{
  readonly path: string;
  readonly cause: unknown;
}> {}

/**
 * A directory that was replaced while it was being observed: `lstat` said directory and `readdir`
 * then said not-found. An observable replacement, never absence. Authoritative callers refuse the
 * capture; diagnostic callers leave the path unclassified.
 */
export class PathChangedError extends Data.TaggedError('PathChangedError')<{
  readonly path: string;
}> {}

/** Not-found in the only two ways a path can be missing: no entry, or a non-directory ancestor. */
function isNotFound(cause: unknown): boolean {
  const code = (cause as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * One directory observation. The first observation of a path is what revalidation compares with.
 */
export type DirectoryObservation =
  | {
      readonly kind: 'directory';
      readonly names: ReadonlySet<string>;
      readonly identity: { readonly dev: number; readonly ino: number };
    }
  /** The path is a link; it is never entered. */
  | { readonly kind: 'symlink' }
  /** A regular file, FIFO, socket or device. */
  | { readonly kind: 'other' }
  /** ENOENT or ENOTDIR from the `lstat`. */
  | { readonly kind: 'absent' }
  /** `lstat` saw a directory and `readdir` then said not-found: a replacement, never absence. */
  | { readonly kind: 'changed' };

/**
 * A capture's own view of the directories it consults.
 *
 * `observe` returns the first observation of a path, memoized for the whole capture; `fatal: true`
 * also marks the path for `revalidate`, which re-reads every marked path fresh through the reader
 * and reports the first whose identity, kind or name set changed. The guarantee is precise: an
 * observable replacement of any directory the capture relied on — including a directory swapped for
 * a link to an empty external directory, whose name set would look unchanged — is refused before
 * commit. It is not a descriptor-relative walk: a pathname `readdir` racing a substituted link can
 * read the link's target once, and what the design promises is that such a capture never succeeds.
 *
 * Every `readdir` in a capture goes through `observe`, so nothing reads a directory without the
 * snapshot knowing. `reader` is exposed for `lstat` and `realpath` only.
 */
export interface DirectorySnapshot {
  readonly observe: (
    absolute: string,
    options: { readonly fatal: boolean },
  ) => Effect.Effect<DirectoryObservation, PathInspectionError>;
  readonly revalidate: () => Effect.Effect<
    { readonly changed: string } | null,
    PathInspectionError
  >;
  readonly reader: DirectoryReader;
}

function readObservation(
  reader: DirectoryReader,
  absolute: string,
): Effect.Effect<DirectoryObservation, PathInspectionError> {
  return Effect.gen(function* () {
    const entry = yield* Effect.tryPromise({
      try: () => reader.lstat(absolute),
      catch: (cause) => cause,
    }).pipe(
      Effect.map((value): EntryStat | null => value),
      Effect.catchAll((cause) =>
        isNotFound(cause)
          ? Effect.succeed(null)
          : Effect.fail(new PathInspectionError({ path: absolute, cause })),
      ),
    );
    if (entry === null) return { kind: 'absent' } as const;
    if (entry.kind === 'symlink') return { kind: 'symlink' } as const;
    if (entry.kind !== 'directory') return { kind: 'other' } as const;
    const names = yield* Effect.tryPromise({
      try: () => reader.readdir(absolute),
      catch: (cause) => cause,
    }).pipe(
      Effect.map((value): readonly string[] | null => value),
      Effect.catchAll((cause) =>
        isNotFound(cause)
          ? Effect.succeed(null)
          : Effect.fail(new PathInspectionError({ path: absolute, cause })),
      ),
    );
    if (names === null) return { kind: 'changed' } as const;
    return {
      kind: 'directory',
      names: new Set(names),
      identity: { dev: entry.dev, ino: entry.ino },
    } as const;
  });
}

function sameObservation(first: DirectoryObservation, again: DirectoryObservation): boolean {
  if (first.kind !== again.kind) return false;
  if (first.kind === 'changed') return false;
  if (first.kind !== 'directory' || again.kind !== 'directory') return true;
  if (first.identity.dev !== again.identity.dev || first.identity.ino !== again.identity.ino) {
    return false;
  }
  if (first.names.size !== again.names.size) return false;
  for (const name of first.names) if (!again.names.has(name)) return false;
  return true;
}

export function makeDirectorySnapshot(reader: DirectoryReader): DirectorySnapshot {
  const observations = new Map<string, DirectoryObservation>();
  // Insertion-ordered, so revalidation reports the first changed path deterministically.
  const fatal = new Set<string>();
  return {
    reader,
    observe: (absolute, options) =>
      Effect.gen(function* () {
        if (options.fatal) fatal.add(absolute);
        const known = observations.get(absolute);
        if (known) return known;
        const observed = yield* readObservation(reader, absolute);
        observations.set(absolute, observed);
        return observed;
      }),
    revalidate: () =>
      Effect.gen(function* () {
        for (const absolute of fatal) {
          const first = observations.get(absolute);
          if (!first) continue;
          const again = yield* readObservation(reader, absolute);
          if (!sameObservation(first, again)) return { changed: absolute };
        }
        return null;
      }),
  };
}

/** Realpath the worktree root once per capture; every walk below starts from the result. */
export function resolveWorktreeRoot(
  reader: DirectoryReader,
  worktreePath: string,
): Effect.Effect<string, PathInspectionError> {
  return Effect.tryPromise({
    try: () => reader.realpath(worktreePath),
    catch: (cause) => new PathInspectionError({ path: worktreePath, cause }),
  });
}

/**
 * Authoritative reads mark every directory they consult for revalidation, because they decide
 * captured bytes or final-state identity. Diagnostic reads only memoize: they inform warnings, and a
 * directory consulted for an unrelated dirty path must be free to change without failing capture.
 */
export type ReadMode = 'authoritative' | 'diagnostic';

/**
 * `verbatim`: every component is present in its parent's listing exactly as spelled.
 * `alias`: some component is not in the listing but `lstat` finds it — the filesystem resolved the
 * spelling to an entry spelled otherwise.
 * `absent`: some component does not exist (ENOENT or ENOTDIR), or lies beneath a link or a
 * non-directory, where no directory entry of this tree can carry it.
 */
export type EntrySpelling = 'verbatim' | 'alias' | 'absent';

function lstatOrNull(
  reader: DirectoryReader,
  absolute: string,
): Effect.Effect<EntryStat | null, PathInspectionError> {
  return Effect.tryPromise({ try: () => reader.lstat(absolute), catch: (cause) => cause }).pipe(
    Effect.map((value): EntryStat | null => value),
    Effect.catchAll((cause) =>
      isNotFound(cause)
        ? Effect.succeed(null)
        : Effect.fail(new PathInspectionError({ path: absolute, cause })),
    ),
  );
}

/**
 * Classify a root-relative spelling against the destination's own directory listings.
 *
 * The filesystem decides, never a string fold (no JavaScript fold matches a filesystem's own case
 * and Unicode equivalence) and never an inode comparison between two verbatim names (hard links
 * share one, and `README.md` beside `readme.md` on a case-sensitive filesystem are two files).
 * `root` is the realpath-ed worktree root.
 */
export function classifyEntrySpelling(
  snapshot: DirectorySnapshot,
  root: string,
  relativePath: string,
  mode: ReadMode,
): Effect.Effect<EntrySpelling, PathInspectionError | PathChangedError> {
  return Effect.gen(function* () {
    const fatal = mode === 'authoritative';
    let parent = root;
    for (const name of relativePath.split('/')) {
      const observed = yield* snapshot.observe(parent, { fatal });
      if (observed.kind === 'changed') return yield* new PathChangedError({ path: parent });
      // A missing parent, or one that is a link or a file: nothing beneath it is an entry of this
      // tree. Links are never entered, so a path "inside" one has no directory-entry spelling.
      if (observed.kind !== 'directory') return 'absent';
      const absolute = join(parent, name);
      if (!observed.names.has(name)) {
        const probed = yield* lstatOrNull(snapshot.reader, absolute);
        return probed === null ? 'absent' : 'alias';
      }
      parent = absolute;
    }
    return 'verbatim';
  });
}

/**
 * Which verbatim entry of the same directory an aliased final component resolved to.
 *
 * Asked only after `classifyEntrySpelling` said `alias` for a path whose parent is itself verbatim,
 * so it never compares two verbatim names. `ambiguous` names every hard-linked candidate and lets
 * the caller decide rather than guessing. No candidate at all means the listing and `lstat`
 * disagree — an observable change.
 */
export function resolveAlias(
  snapshot: DirectorySnapshot,
  root: string,
  aliased: string,
  mode: ReadMode,
): Effect.Effect<
  | { readonly kind: 'unique'; readonly entry: string }
  | { readonly kind: 'ambiguous'; readonly entries: readonly string[] },
  PathInspectionError | PathChangedError
> {
  return Effect.gen(function* () {
    const slash = aliased.lastIndexOf('/');
    const parentRelative = slash === -1 ? '' : aliased.slice(0, slash);
    const name = aliased.slice(slash + 1);
    const parent = parentRelative === '' ? root : join(root, parentRelative);
    const observed = yield* snapshot.observe(parent, { fatal: mode === 'authoritative' });
    if (observed.kind !== 'directory') return yield* new PathChangedError({ path: parent });
    const target = yield* lstatOrNull(snapshot.reader, join(parent, name));
    if (target === null) return yield* new PathChangedError({ path: join(parent, name) });
    const matches: string[] = [];
    for (const candidate of [...observed.names].sort()) {
      const candidateStat = yield* lstatOrNull(snapshot.reader, join(parent, candidate));
      if (candidateStat && candidateStat.dev === target.dev && candidateStat.ino === target.ino) {
        matches.push(parentRelative === '' ? candidate : `${parentRelative}/${candidate}`);
      }
    }
    if (matches.length === 0) return yield* new PathChangedError({ path: join(parent, name) });
    if (matches.length === 1) return { kind: 'unique', entry: matches[0]! } as const;
    return { kind: 'ambiguous', entries: matches } as const;
  });
}

/**
 * Why a checkpoint scope root cannot be captured. Not-found is not here: an absent root is the
 * `absent` resolution, and only the capture service knows whether that is an intentional empty
 * recapture or a typo.
 */
export interface ScopeRootError {
  readonly reason:
    | 'scope_root_is_symlink'
    | 'scope_kind_mismatch'
    | 'scope_path_spelling_mismatch'
    | 'unstable_capture'
    | 'path_inspection_failed';
  /** Root-relative: the scope root, the offending exclusion, or the component that failed. */
  readonly path: string;
  readonly cause?: unknown;
}

export type ScopeRootResolution =
  /** Verbatim spelling; every directory the walk entered, the root included, is marked fatal. */
  | { readonly kind: 'present'; readonly absolute: string }
  /** ENOENT or ENOTDIR under this spelling, proven only after every existing ancestor passed. */
  | { readonly kind: 'absent' }
  /** Exists, but the directory spells the entry otherwise. */
  | { readonly kind: 'alias' };

/**
 * Resolve one checkpoint scope root by a component walk from the realpath-ed root, never by a
 * realpath of the joined target (which can neither yield `absent` nor prove an existing prefix safe).
 *
 * Each component must be present verbatim in its parent's listing. Every existing non-final
 * component must first be observed as a directory: a link anywhere is `scope_root_is_symlink`, and
 * a file or special entry is `scope_kind_mismatch`. The final component must match `kind`. Only
 * verbatim entries observed as directories are entered, and every one is marked fatal, so an
 * observable replacement of any of them is refused by the capture's revalidation. Exclusions that
 * exist must be verbatim too; absent ones are fine. Evidence's `resolveWithinWorktree` is unchanged.
 */
export function resolveScopeRoot(
  snapshot: DirectorySnapshot,
  root: string,
  relativePath: string,
  kind: 'directory' | 'file',
  exclusions: readonly string[],
): Effect.Effect<ScopeRootResolution, ScopeRootError> {
  const fail = (reason: ScopeRootError['reason'], path: string, cause?: unknown) =>
    Effect.fail<ScopeRootError>(cause === undefined ? { reason, path } : { reason, path, cause });
  const inspection = (error: PathInspectionError | PathChangedError, path: string) =>
    error._tag === 'PathChangedError'
      ? fail('unstable_capture', path)
      : fail('path_inspection_failed', path, error.cause);

  return Effect.gen(function* () {
    const names = relativePath.split('/');
    let parent = root;
    for (const [index, name] of names.entries()) {
      const spelled = names.slice(0, index + 1).join('/');
      const final = index === names.length - 1;
      const observed = yield* snapshot
        .observe(parent, { fatal: true })
        .pipe(Effect.catchAll((error) => inspection(error, spelled)));
      if (observed.kind !== 'directory') return yield* fail('unstable_capture', spelled);
      const absolute = join(parent, name);
      if (!observed.names.has(name)) {
        const probed = yield* lstatOrNull(snapshot.reader, absolute).pipe(
          Effect.catchAll((error) => inspection(error, spelled)),
        );
        return probed === null ? ({ kind: 'absent' } as const) : ({ kind: 'alias' } as const);
      }
      if (!final) {
        const entered = yield* snapshot
          .observe(absolute, { fatal: true })
          .pipe(Effect.catchAll((error) => inspection(error, spelled)));
        if (entered.kind === 'symlink') return yield* fail('scope_root_is_symlink', spelled);
        if (entered.kind === 'other') return yield* fail('scope_kind_mismatch', spelled);
        // Listed a moment ago, gone or replaced now.
        if (entered.kind !== 'directory') return yield* fail('unstable_capture', spelled);
        parent = absolute;
        continue;
      }
      const entry = yield* lstatOrNull(snapshot.reader, absolute).pipe(
        Effect.catchAll((error) => inspection(error, spelled)),
      );
      if (entry === null) return yield* fail('unstable_capture', spelled);
      if (entry.kind === 'symlink') return yield* fail('scope_root_is_symlink', spelled);
      if (kind === 'file') {
        if (entry.kind !== 'file') return yield* fail('scope_kind_mismatch', spelled);
        return { kind: 'present', absolute } as const;
      }
      if (entry.kind !== 'directory') return yield* fail('scope_kind_mismatch', spelled);
      const entered = yield* snapshot
        .observe(absolute, { fatal: true })
        .pipe(Effect.catchAll((error) => inspection(error, spelled)));
      if (entered.kind !== 'directory') return yield* fail('unstable_capture', spelled);
      for (const exclusion of exclusions) {
        const excluded = `${relativePath}/${exclusion}`;
        const spelling = yield* classifyEntrySpelling(
          snapshot,
          root,
          excluded,
          'authoritative',
        ).pipe(Effect.catchAll((error) => inspection(error, excluded)));
        if (spelling === 'alias') return yield* fail('scope_path_spelling_mismatch', excluded);
      }
      return { kind: 'present', absolute } as const;
    }
    // `normalizeWorktreeRelativePath` never yields an empty path, so the loop always returns.
    return yield* fail('path_inspection_failed', relativePath);
  });
}
