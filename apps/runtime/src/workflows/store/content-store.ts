import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open as openFile, readFile, rename, rm, utimes } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { Clock, Context, Data, Duration, Effect, Layer, Scope } from 'effect';

import { diagnosticPhase } from '../../platform/diagnostics/index.js';
import { runPeriodically } from '../../platform/fibers/index.js';
import {
  DataDirectory,
  RuntimeDatabase,
  childDirectory,
  listOrphanCandidates,
  openCollectorRoot,
  sweepOrphans,
  type GuardedDirectory,
  type OrphanCandidate,
  type OrphanSweepStats,
} from '../../platform/persistence/index.js';
import { listReferencedContentHashes } from './checkpoints.js';

/**
 * Immutable, content-addressed bytes on disk: where checkpoint file copies live.
 *
 * A content reference is the plain string `sha256:<64 hex>`, validated by `refPattern` on every
 * read. There is no database catalog: the file is the record, and a checkpoint row's file list is
 * what keeps it alive.
 *
 * Unreferenced content is reclaimed by `collectGarbage`, an hourly mark-and-sweep over this store's
 * root: a blob or temp is deleted only when no checkpoint references it, no open capture holds it,
 * and it is older than the grace period. Age alone is not enough. A capture copies files one by one
 * and inserts the checkpoint row that references them only at the end, and nothing bounds that
 * interval, so a blob reused early in a long capture can be older than any grace period before it
 * is referenced. Three rules close that gap:
 *
 * - **Capture lease.** Publication only happens through a capture (`openCapture`). Every blob a
 *   capture publishes or reuses, and every temp it is writing, is held in memory until its scope
 *   closes, and checkpoint capture keeps that scope open until its row has committed.
 * - **Release tracking.** A sweep reads its mark at one moment; a checkpoint may commit and release
 *   its lease after that. From before the mark read begins until the sweep ends, every released
 *   hash is remembered and kept, so the stale mark never decides alone. Only the order matters, not
 *   adjacency: a capture whose row commits after the read released after tracking started.
 * - **Reuse refresh.** Reusing an existing blob refreshes its mtime (`reuseExisting`).
 *
 * There is no lock. Hold, release, temp registration, "start tracking", and the collector's
 * per-candidate decide-and-remove step (`sweepOrphans`) are each one synchronous block on the
 * runtime's single thread (plain code between two `yield*`s, or one `Effect.sync`), so none can
 * interleave with another. Keep them free of `await` and `yield*`.
 */
const refPattern = /^sha256:[a-f0-9]{64}$/;

/**
 * The collector's tunables. Unreferenced content is reclaimed within about grace plus interval. Tests
 * provide `Layer.succeed(WorkflowContentGcSettings, {...})`.
 */
export const WorkflowContentGcSettings = Context.Reference<{
  /** How often the collector runs. The first run is one interval after the store starts. */
  readonly interval: Duration.Duration;
  /** How old an unreferenced, unheld blob or temp must be before it is deleted. */
  readonly grace: Duration.Duration;
}>('isagi/runtime/workflows/WorkflowContentGcSettings', {
  defaultValue: () => ({ interval: Duration.hours(1), grace: Duration.hours(1) }),
});

const shardPattern = /^[0-9a-f]{2}$/;
const temporaryPattern = /^[0-9a-f-]{36}\.tmp$/;
const gcLabel = 'workflow content';

export class ContentPublishError extends Data.TaggedError('ContentPublishError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * A reference resolved to nothing usable: the file is gone, or its bytes no longer hash to the
 * reference. Neither is ever repaired by substituting an empty value.
 */
export class ContentUnavailable extends Data.TaggedError('ContentUnavailable')<{
  readonly ref: string;
  readonly cause: 'missing' | 'corrupt';
}> {}

export interface ContentCapture {
  /**
   * Publishes a stream's bytes and returns the reference that names them. The bytes are hashed as
   * they stream to disk, so a large file never has to be materialised, and an existing file that
   * verifies is reused instead of replaced.
   *
   * Fails with `ContentPublishError` when the capture's scope closed before this put could take its
   * hold; such a put leaves no hold and no temp behind. Interrupting a put tears its stream down and
   * removes its temp.
   */
  readonly put: (input: {
    readonly source: Readable;
  }) => Effect.Effect<
    { readonly contentRef: string; readonly byteSize: number },
    ContentPublishError
  >;
}

/** The store plus its collector. The collector is deliberately not on the service tag. */
export interface WorkflowContentStoreInstance {
  readonly service: WorkflowContentStore['Service'];
  readonly collectGarbage: <E>(input: ContentGcInput<E>) => Effect.Effect<ContentGcResult, E>;
}

export interface ContentGcInput<E> {
  readonly nowMs: number;
  readonly minAgeMs: number;
  /**
   * The mark: every hash a checkpoint references. Run inside the sweep after release tracking has
   * started, and only when something is old enough to collect. A failure aborts the sweep before
   * anything is removed, and the sweep fails with it.
   */
  readonly referencedHashes: Effect.Effect<ReadonlySet<string>, E>;
}

export type ContentGcResult =
  | {
      readonly status: 'skipped';
      readonly reason: 'already_running' | 'nothing_old' | 'root_unusable';
    }
  | { readonly status: 'swept'; readonly stats: OrphanSweepStats };

const make = Effect.gen(function* () {
  const directory = yield* DataDirectory;
  const database = yield* RuntimeDatabase;
  const settings = yield* WorkflowContentGcSettings;
  const store = makeWorkflowContentStore(directory.paths.root);
  const referencedHashes = database.use(
    'list_referenced_content_hashes',
    listReferencedContentHashes,
  );

  // A failed tick (a failed mark read, or a defect) is logged by the loop, and the next tick runs.
  yield* runPeriodically(
    'Workflow content GC',
    settings.interval,
    diagnosticPhase(
      'workflow.content_gc',
      {},
      Effect.flatMap(Clock.currentTimeMillis, (nowMs) =>
        store.collectGarbage({
          nowMs,
          minAgeMs: Duration.toMillis(settings.grace),
          referencedHashes,
        }),
      ),
    ),
  );

  return store.service;
});

/**
 * The store and its hourly collector. Reference `WorkflowContentStore.layer` (never a second layer
 * value) so the build memoizes it and exactly one collector runs over the root. There is no
 * startup pass: the first tick is one interval in, and closing the layer's scope stops the
 * collector, mid-sweep included.
 */
export class WorkflowContentStore extends Context.Service<
  WorkflowContentStore,
  {
    /**
     * Opens a capture lease. Every blob published or reused through it, and every temp it is writing,
     * is protected from the collector until the scope closes. Checkpoint capture keeps the scope open
     * until its checkpoint row has committed or the capture has failed.
     */
    readonly openCapture: Effect.Effect<ContentCapture, never, Scope.Scope>;
    /**
     * Verifies the whole file against its hash, then streams it. Two sequential reads per fetch.
     *
     * The cost is deliberate. A hash can only be confirmed at the last byte, and by then a streaming
     * response has long since sent its status line; aborting a half-sent body would make "corrupt"
     * indistinguishable to the client from a dropped connection. So the file is read once to prove it
     * matches its reference and once to serve it, and a 200 never carries unverified bytes.
     */
    readonly open: (ref: string) => Effect.Effect<Readable, ContentUnavailable>;
    /** Verifies in memory and returns the whole value. */
    readonly readAll: (ref: string) => Effect.Effect<Buffer, ContentUnavailable>;
  }
>()('isagi/runtime/workflows/WorkflowContentStore') {
  static readonly layer = Layer.effect(WorkflowContentStore, make);
}

/**
 * Absolute path of a reference's backing file under the store's root (`<data>/workflow-content`).
 * Test and diagnostic use only.
 *
 * Deliberately a module function rather than a member of the service: no caller may resolve a
 * reference to a path to read it, because that would bypass verification. It lives here, beside the
 * adapter that owns the layout, so the tests that need to corrupt or delete a blob cannot drift
 * from where the adapter actually writes it.
 */
export function contentPathFor(root: string, ref: string): string {
  const hash = ref.slice('sha256:'.length);
  return join(root, hash.slice(0, 2), `${hash}.json`);
}

/** One open capture's lease: the hashes it holds, and whether its scope has closed. */
interface CaptureLease {
  readonly holds: Set<string>;
  closed: boolean;
}

/**
 * The store, independent of how its dependencies are provided.
 *
 * Exported so tests can drive it, and its collector, against a temporary data root without standing
 * up the whole layer graph. The store's root is `<dataRoot>/workflow-content`; the collector is
 * given the data root itself so it can check every directory below it for links.
 *
 * Every blob lives at `<root>/<first-2-hex>/<hash>.json`, whatever it actually contains. The
 * `.json` suffix on a PNG is a known wart: the name is private to this adapter, references are
 * opaque on the wire, and a second root with a legacy fallback would be a dual system for a
 * cosmetic gain. Renaming it is a one-line change for a future story that resets data roots.
 */
export function makeWorkflowContentStore(dataRoot: string): WorkflowContentStoreInstance {
  const root = join(dataRoot, 'workflow-content');
  const incoming = join(root, 'incoming');
  const pathFor = (ref: string) => contentPathFor(root, ref);

  // The lease ledger. Only `hold` (on an open capture) and `release` change `held`, and `held[h]`
  // always equals the number of open captures holding `h`; it never stores 0.
  const held = new Map<string, number>();
  const liveTemps = new Set<string>();
  // Non-null exactly while a sweep is between "start tracking" and its end.
  let releasedDuringSweep: Set<string> | null = null;
  let sweeping = false;

  // Synchronous. A closed capture refuses, so no hold is ever acquired after its release.
  const hold = (lease: CaptureLease, hash: string): boolean => {
    if (lease.closed) return false;
    if (!lease.holds.has(hash)) {
      lease.holds.add(hash);
      held.set(hash, (held.get(hash) ?? 0) + 1);
    }
    return true;
  };

  // Synchronous: the capture scope's finalizer. Copy work still running for a closed capture is
  // neither cancelled nor awaited. Its next hold is refused, and nothing it finishes can be
  // referenced, because the only referencing commit runs inside the scope that just closed.
  const release = (lease: CaptureLease) => {
    if (lease.closed) return;
    lease.closed = true;
    for (const hash of lease.holds) {
      const count = (held.get(hash) ?? 0) - 1;
      if (count > 0) held.set(hash, count);
      else held.delete(hash);
      releasedDuringSweep?.add(hash);
    }
  };

  /**
   * Claims a temp name under `<root>/incoming/` and registers it as live, synchronously, before the
   * file exists. The put unregisters it once the temp has been renamed into place or removed, so
   * the collector never takes a temp that a put still owns.
   *
   * Temps are staged here rather than beside the final blob so shard folders never hold
   * half-written files. A temp left by a hard kill or power loss is no longer live after restart,
   * and the collector deletes it once it is older than the grace period; that is the only cleanup
   * crash residue needs, so no other sweep belongs here.
   */
  const stage = (): StagedTemporary => {
    const name = `${randomUUID()}.tmp`;
    liveTemps.add(name);
    return { name, path: join(incoming, name) };
  };

  const publishStaged = Effect.fnUntraced(function* (
    lease: CaptureLease,
    source: Readable,
    temporary: StagedTemporary,
  ) {
    const hash = createHash('sha256');
    let byteSize = 0;
    const measure = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        byteSize += chunk.byteLength;
        callback(null, chunk);
      },
    });
    // The signal tears the pipeline down when the put is interrupted.
    yield* publishing(async (signal) => {
      await mkdir(incoming, { recursive: true });
      await pipeline(source, measure, createWriteStream(temporary.path, { flags: 'wx' }), {
        signal,
      });
    }).pipe(
      Effect.onError(() =>
        Effect.sync(() => source.destroy()).pipe(Effect.andThen(removeQuietly(temporary.path))),
      ),
    );
    const digest = hash.digest('hex');
    // The hold is taken here, in the same synchronous step as the end of the stream, so the reuse
    // check that follows sees either a blob the collector can no longer remove or no blob at all.
    if (!hold(lease, digest)) {
      yield* removeQuietly(temporary.path);
      return yield* closedCapture();
    }
    const contentRef = `sha256:${digest}`;
    yield* publishing(() => commitTemporary(pathFor(contentRef), temporary.path, contentRef));
    return { contentRef, byteSize };
  });

  const put = (lease: CaptureLease) =>
    Effect.fnUntraced(function* (input: { readonly source: Readable }) {
      if (lease.closed) {
        input.source.destroy();
        return yield* closedCapture();
      }
      return yield* Effect.acquireUseRelease(
        Effect.sync(stage),
        (temporary) => publishStaged(lease, input.source, temporary),
        (temporary) => Effect.sync(() => liveTemps.delete(temporary.name)),
      );
    });

  /**
   * Everything a read does that is *not* its read strategy.
   *
   * The syntax guard and the failure mapping are the same whichever way the bytes are fetched, and
   * they would otherwise have to be kept in step across two paths — including if a third `cause` is
   * ever added. Anything the strategy throws is reported as `missing`, so a permissions error or a
   * vanished file is an honest answer rather than a defect escaping the store. A strategy that read
   * bytes which do not match the reference answers `corrupt`. Only the strategy differs between
   * `open` and `readAll`; keep it that way.
   */
  const reading = <A>(
    ref: string,
    strategy: (path: string, signal: AbortSignal) => Promise<Verified<A>>,
  ): Effect.Effect<A, ContentUnavailable> =>
    Effect.suspend(() =>
      refPattern.test(ref)
        ? Effect.tryPromise({
            try: (signal) => strategy(pathFor(ref), signal),
            catch: () => new ContentUnavailable({ ref, cause: 'missing' }),
          })
        : Effect.fail(new ContentUnavailable({ ref, cause: 'missing' })),
    ).pipe(
      Effect.flatMap((result) =>
        result.verified
          ? Effect.succeed(result.value)
          : Effect.fail(new ContentUnavailable({ ref, cause: 'corrupt' })),
      ),
    );

  const openCapture: Effect.Effect<ContentCapture, never, Scope.Scope> = Effect.acquireRelease(
    Effect.sync((): CaptureLease => ({ holds: new Set(), closed: false })),
    (lease) => Effect.sync(() => release(lease)),
  ).pipe(Effect.map((lease): ContentCapture => ({ put: put(lease) })));

  /**
   * Blobs (`<hh>/<hash>.json`) and temps (`incoming/<uuid>.tmp`), reached only through real
   * directories. Shard folders and `incoming` itself are never candidates.
   */
  const listCandidates = Effect.fnUntraced(function* () {
    const opened = yield* openCollectorRoot(dataRoot, ['workflow-content'], gcLabel);
    if (opened.status === 'absent') return 'absent' as const;
    if (opened.status === 'unusable') return 'root_unusable' as const;
    const shards = yield* listOrphanCandidates(
      opened.directory,
      'directory',
      (name) => shardPattern.test(name),
      gcLabel,
    );
    if (shards.status === 'unreadable') return 'root_unusable' as const;

    const folders: { readonly directory: GuardedDirectory; readonly accept: RegExp }[] = [];
    for (const shard of shards.candidates) {
      const child = yield* childDirectory(opened.directory, shard.name, gcLabel);
      if (child.status === 'ready') {
        folders.push({
          directory: child.directory,
          accept: new RegExp(`^${shard.name}[0-9a-f]{62}\\.json$`),
        });
      }
    }
    const temps = yield* childDirectory(opened.directory, 'incoming', gcLabel);
    if (temps.status === 'ready')
      folders.push({ directory: temps.directory, accept: temporaryPattern });

    const candidates: OrphanCandidate[] = [];
    for (const folder of folders) {
      yield* Effect.yieldNow;
      const listed = yield* listOrphanCandidates(
        folder.directory,
        'file',
        (name) => folder.accept.test(name),
        gcLabel,
      );
      if (listed.status === 'unreadable') return 'root_unusable' as const;
      candidates.push(...listed.candidates);
    }
    return candidates;
  });

  // The one place liveness is decided, inside the collector's synchronous per-candidate step.
  const isLiveContent = (candidate: OrphanCandidate, mark: ReadonlySet<string>) => {
    if (temporaryPattern.test(candidate.name)) return liveTemps.has(candidate.name);
    const hash = candidate.name.slice(0, 64);
    return held.has(hash) || (releasedDuringSweep?.has(hash) ?? false) || mark.has(hash);
  };

  const sweepOnce = Effect.fnUntraced(function* <E>(input: ContentGcInput<E>) {
    const listed = yield* listCandidates();
    if (listed === 'absent') return nothingOld;
    if (listed === 'root_unusable') return rootUnusable;

    // Age only. Whether a candidate is held, referenced or live is decided in the sweep step.
    const old: OrphanCandidate[] = [];
    for (const candidate of listed) {
      // Gone or unreadable: not a candidate this time.
      const mtimeMs = yield* Effect.promise(() =>
        lstat(candidate.path).then(
          (stat) => stat.mtimeMs,
          () => null,
        ),
      );
      if (mtimeMs !== null && input.nowMs - mtimeMs >= input.minAgeMs) old.push(candidate);
    }
    if (old.length === 0) return nothingOld;

    // Tracking starts before the mark read begins, so a capture that releases at any point after
    // this (during the read included) is kept by this sweep even though the mark predates its row.
    yield* Effect.sync(() => {
      releasedDuringSweep = new Set();
    });
    const mark = yield* input.referencedHashes;

    const stats = yield* sweepOrphans({
      label: 'workflow content file',
      candidates: old,
      isLive: (candidate) => isLiveContent(candidate, mark),
      minAgeMs: input.minAgeMs,
      nowMs: input.nowMs,
    });
    const swept: ContentGcResult = { status: 'swept', stats };
    return swept;
  });

  // The check and the claim are one synchronous step, so overlapping sweeps are refused.
  const collectGarbage = <E>(input: ContentGcInput<E>): Effect.Effect<ContentGcResult, E> =>
    Effect.suspend(() => {
      if (sweeping) return Effect.succeed(alreadyRunning);
      sweeping = true;
      return sweepOnce(input).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            releasedDuringSweep = null;
            sweeping = false;
          }),
        ),
      );
    });

  return {
    service: WorkflowContentStore.of({
      openCapture,

      open: Effect.fn('WorkflowContentStore.open')(function* (ref: string) {
        // Verified on every read. A reference is a claim about bytes, and an unverified read would
        // let a truncated or edited file be presented as recorded history.
        const verifiedPath = yield* reading(ref, async (path, signal) =>
          `sha256:${await hashFile(path, signal)}` === ref
            ? { verified: true, value: path }
            : notVerified,
        );
        return createReadStream(verifiedPath);
      }),

      /**
       * One read, then verify the buffer that read produced.
       *
       * Deliberately not a verifying pre-pass plus a second read. `open` pre-verifies because it
       * cannot verify while streaming; a whole-value read is already holding the bytes it needs to
       * hash, so pre-verifying would double the IO to buy nothing. The "verified on every read"
       * invariant is identical either way.
       */
      readAll: Effect.fn('WorkflowContentStore.readAll')(function* (ref: string) {
        return yield* reading(ref, async (path, signal) => {
          const bytes = await readFile(path, { signal });
          return `sha256:${sha256(bytes)}` === ref ? { verified: true, value: bytes } : notVerified;
        });
      }),
    }),
    collectGarbage,
  };
}

interface StagedTemporary {
  readonly name: string;
  readonly path: string;
}

type Verified<A> = { readonly verified: true; readonly value: A } | { readonly verified: false };
const notVerified = { verified: false } as const;

const alreadyRunning: ContentGcResult = { status: 'skipped', reason: 'already_running' };
const nothingOld: ContentGcResult = { status: 'skipped', reason: 'nothing_old' };
const rootUnusable: ContentGcResult = { status: 'skipped', reason: 'root_unusable' };

function closedCapture() {
  return new ContentPublishError({
    message: 'The checkpoint capture has closed, so its content can no longer be published.',
  });
}

/** One filesystem step of a put. Any failure is the put's generic publish failure. */
function publishing<A>(
  operation: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, ContentPublishError> {
  return Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      new ContentPublishError({ message: 'Could not publish workflow content.', cause }),
  });
}

/** Best-effort removal of a temp the put owns; a failure leaves it for the collector. */
function removeQuietly(path: string): Effect.Effect<void> {
  return Effect.promise(() => rm(path, { force: true }).catch(() => undefined));
}

/**
 * A fully written temp file becomes the blob, or it does not exist at all.
 *
 * The temp is fsynced, renamed, and then the *directory* is fsynced too — without that last step
 * the rename itself can be lost by a crash, leaving a reference pointing at nothing. An existing
 * correct file is reused, so republishing identical bytes costs one hash rather than one file.
 */
async function commitTemporary(path: string, temporary: string, ref: string): Promise<void> {
  const folder = dirname(path);
  try {
    if (await reuseExisting(path, ref)) {
      await rm(temporary, { force: true }).catch(() => undefined);
      return;
    }
    await mkdir(folder, { recursive: true });
    await syncPath(temporary);
    await rename(temporary, path);
    await syncDirectory(folder);
  } catch (cause) {
    await rm(temporary, { force: true }).catch(() => undefined);
    // A concurrent publisher of identical content is a success, not a conflict.
    if (await reuseExisting(path, ref)) return;
    throw cause;
  }
}

/**
 * The only reuse primitive. Reuse refreshes the blob's mtime first, so content a capture keeps
 * using never ages out. A blob the collector already removed fails `utimes` with ENOENT and is not
 * reusable, so a fresh copy is published; a corrupt blob is touched, fails verification, and is
 * replaced by the rename.
 */
async function reuseExisting(path: string, ref: string): Promise<boolean> {
  try {
    const now = new Date();
    await utimes(path, now, now);
  } catch {
    return false;
  }
  return verifies(path, ref);
}

async function verifies(path: string, ref: string): Promise<boolean> {
  try {
    return `sha256:${await hashFile(path)}` === ref;
  } catch {
    return false;
  }
}

/** Hashes a file without holding it in memory, so verification costs a read and not a copy. */
async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, signal ? { signal } : {})) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

async function syncPath(path: string) {
  const handle = await openFile(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Syncing the directory is what makes the rename itself survive a crash; without it a reference can
 * outlive the entry that resolves it. POSIX allows opening a directory read-only, which is how this
 * is done on macOS and Linux. Windows does not, and there the rename is already committed by the
 * filesystem, so a platform refusal is tolerated rather than failing a correct publication.
 */
const directorySyncUnsupported = new Set(['EISDIR', 'EPERM', 'EACCES', 'EINVAL', 'ENOTSUP']);

async function syncDirectory(path: string) {
  try {
    await syncPath(path);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (!code || !directorySyncUnsupported.has(code)) throw cause;
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
