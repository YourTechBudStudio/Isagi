import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open as openFile, readFile, rename, rm, utimes } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { Cause, Context, Data, Effect, Layer, Scope } from 'effect';

import { diagnosticPhase } from '../../diagnostics/phase.js';
import { DataDirectory, RuntimeDatabase } from '../../persistence/index.js';
import {
  childDirectory,
  listOrphanCandidates,
  openCollectorRoot,
  sweepOrphans,
  type GuardedDirectory,
  type OrphanCandidate,
  type OrphanSweepStats,
} from '../../persistence/orphan-files.js';
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
 *   its lease after that. From just before the mark is read until the sweep ends, every released
 *   hash is remembered and kept, so the stale mark never decides alone.
 * - **Reuse refresh.** Reusing an existing blob refreshes its mtime (`reuseExisting`).
 *
 * There is no lock. Hold, release, temp registration, "start tracking then read the mark", and the
 * collector's per-candidate decide-and-remove step (`sweepOrphans`) are each synchronous JavaScript
 * on the runtime's single thread, so none can interleave with another. Keep them free of `await`.
 */
const refPattern = /^sha256:[a-f0-9]{64}$/;

/** Tunable. Unreferenced content is reclaimed within about grace plus interval. */
const contentGcGraceMs = 60 * 60_000;
const contentGcIntervalMs = 60 * 60_000;

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

export interface WorkflowContentStoreService {
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

export interface ContentCapture {
  /**
   * Publishes a stream's bytes and returns the reference that names them. The bytes are hashed as
   * they stream to disk, so a large file never has to be materialised, and an existing file that
   * verifies is reused instead of replaced.
   *
   * Fails with `ContentPublishError` when the capture's scope closed before this put could take its
   * hold; such a put leaves no hold and no temp behind.
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
  readonly service: WorkflowContentStoreService;
  readonly collectGarbage: (input: ContentGcInput) => Promise<ContentGcResult>;
}

export interface ContentGcInput {
  readonly nowMs: number;
  readonly minAgeMs: number;
  /**
   * Synchronous mark read: every hash a checkpoint references. Called inside the sweep right after
   * release tracking starts. A throw aborts the sweep before anything is removed and rejects it.
   */
  readonly referencedHashes: () => ReadonlySet<string>;
}

export type ContentGcResult =
  | {
      readonly status: 'skipped';
      readonly reason: 'already_running' | 'nothing_old' | 'root_unusable';
    }
  | { readonly status: 'swept'; readonly stats: OrphanSweepStats };

export const WorkflowContentStore = Context.GenericTag<WorkflowContentStoreService>(
  'isagi/WorkflowContentStore',
);

/**
 * The store and its hourly collector. Bind this layer once (`runtime.layer.ts`) so exactly one
 * collector runs over the root. There is no startup pass: the first tick is one interval in.
 */
export const WorkflowContentStoreLive = Layer.scoped(
  WorkflowContentStore,
  Effect.gen(function* () {
    const directory = yield* DataDirectory;
    const database = yield* RuntimeDatabase;
    const instance = makeWorkflowContentStore(directory.paths.root);

    const tick = diagnosticPhase(
      'workflow.content_gc',
      {},
      Effect.promise(() =>
        instance.collectGarbage({
          nowMs: Date.now(),
          minAgeMs: contentGcGraceMs,
          referencedHashes: () =>
            Effect.runSync(
              database.use('list_referenced_content_hashes', listReferencedContentHashes),
            ),
        }),
      ),
    ).pipe(
      // catchAllCause, not catchAll: a rejected promise (a failed mark read included) is a defect
      // here, and it must be logged and leave the next tick running.
      Effect.catchAllCause((cause) =>
        Effect.sync(() =>
          console.warn('[runtime] Workflow content GC failed', Cause.pretty(cause)),
        ),
      ),
    );
    const timer = setInterval(() => {
      void Effect.runPromise(tick);
    }, contentGcIntervalMs);
    timer.unref();
    yield* Effect.addFinalizer(() => Effect.sync(() => clearInterval(timer)));

    return instance.service;
  }),
);

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
   * The only reuse primitive. Reuse refreshes the blob's mtime first, so content a capture keeps
   * using never ages out. A blob the collector already removed fails `utimes` with ENOENT and is
   * not reusable, so a fresh copy is published; a corrupt blob is touched, fails verification, and
   * is replaced by the rename.
   */
  const reuseExisting = async (path: string, ref: string) => {
    try {
      const now = new Date();
      await utimes(path, now, now);
    } catch {
      return false;
    }
    return verifies(path, ref);
  };

  /**
   * A fully written temp file becomes the blob, or it does not exist at all.
   *
   * The temp is fsynced, renamed, and then the *directory* is fsynced too — without that last step
   * the rename itself can be lost by a crash, leaving a reference pointing at nothing. An existing
   * correct file is reused, so republishing identical bytes costs one hash rather than one file.
   */
  const commitTemporary = async (temporary: string, ref: string) => {
    const path = pathFor(ref);
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
  };

  /**
   * Claims a temp name under `<root>/incoming/` and registers it as live, synchronously, before the
   * file exists. The caller unregisters it once the temp has been renamed into place or removed, so
   * the collector never takes a temp that a put still owns.
   *
   * Temps are staged here rather than beside the final blob so shard folders never hold
   * half-written files. A temp left by a hard kill or power loss is no longer live after restart,
   * and the collector deletes it once it is older than the grace period; that is the only cleanup
   * crash residue needs, so no other sweep belongs here.
   */
  const stage = () => {
    const name = `${randomUUID()}.tmp`;
    liveTemps.add(name);
    return { name, path: join(incoming, name) };
  };

  const putStream = async (lease: CaptureLease, source: Readable) => {
    if (lease.closed) {
      source.destroy();
      throw closedCapture();
    }
    const temporary = stage();
    try {
      const hash = createHash('sha256');
      let byteSize = 0;
      try {
        await mkdir(incoming, { recursive: true });
        const measure = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            hash.update(chunk);
            byteSize += chunk.byteLength;
            callback(null, chunk);
          },
        });
        await pipeline(source, measure, createWriteStream(temporary.path, { flags: 'wx' }));
      } catch (cause) {
        source.destroy();
        await rm(temporary.path, { force: true }).catch(() => undefined);
        throw cause;
      }
      const digest = hash.digest('hex');
      // The hold is taken here, before the next await, so the reuse check that follows sees either
      // a blob the collector can no longer remove or no blob at all.
      if (!hold(lease, digest)) {
        await rm(temporary.path, { force: true }).catch(() => undefined);
        throw closedCapture();
      }
      const ref = `sha256:${digest}`;
      await commitTemporary(temporary.path, ref);
      return { contentRef: ref, byteSize };
    } finally {
      liveTemps.delete(temporary.name);
    }
  };

  /**
   * Everything a read does that is *not* its read strategy.
   *
   * The syntax guard and the failure mapping are the same whichever way the bytes are fetched, and
   * they would otherwise have to be kept in step across two paths — including if a third `cause` is
   * ever added. Anything the strategy throws that is not already a `ContentUnavailable` is reported
   * as `missing`, so a permissions error or a vanished file is an honest answer rather than a
   * defect escaping the store. Only the strategy differs between `open` and `readAll`; keep it that
   * way.
   */
  const reading = <A>(ref: string, strategy: (path: string) => Promise<A>) =>
    Effect.tryPromise({
      try: async () => {
        if (!refPattern.test(ref)) throw new ContentUnavailable({ ref, cause: 'missing' });
        return await strategy(pathFor(ref));
      },
      catch: (cause) =>
        cause instanceof ContentUnavailable
          ? cause
          : new ContentUnavailable({ ref, cause: 'missing' }),
    });

  /**
   * The verifying pre-pass `open` needs, and only `open`.
   *
   * A streaming response cannot verify as it serves — the hash is only known at the last byte, long
   * after the status line has gone out — so the file is hashed first and streamed second. A reader
   * that materialises the whole value has no such constraint and must not pay this cost; see
   * `readAll`.
   */
  const verifiedPathFor = (ref: string) =>
    reading(ref, async (path) => {
      // Verified on every read. A reference is a claim about bytes, and an unverified read would
      // let a truncated or edited file be presented as recorded history.
      if (`sha256:${await hashFile(path)}` !== ref) {
        throw new ContentUnavailable({ ref, cause: 'corrupt' });
      }
      return path;
    });

  const openCapture: Effect.Effect<ContentCapture, never, Scope.Scope> = Effect.acquireRelease(
    Effect.sync((): CaptureLease => ({ holds: new Set(), closed: false })),
    (lease) => Effect.sync(() => release(lease)),
  ).pipe(
    Effect.map(
      (lease): ContentCapture => ({
        put: ({ source }) =>
          Effect.tryPromise({
            try: () => putStream(lease, source),
            catch: (cause) =>
              cause instanceof ContentPublishError
                ? cause
                : new ContentPublishError({
                    message: 'Could not publish workflow content.',
                    cause,
                  }),
          }),
      }),
    ),
  );

  /**
   * Blobs (`<hh>/<hash>.json`) and temps (`incoming/<uuid>.tmp`), reached only through real
   * directories. Shard folders and `incoming` itself are never candidates.
   */
  const listCandidates = async (): Promise<
    readonly OrphanCandidate[] | 'absent' | 'root_unusable'
  > => {
    const opened = openCollectorRoot(dataRoot, ['workflow-content'], gcLabel);
    if (opened.status === 'absent') return 'absent';
    if (opened.status === 'unusable') return 'root_unusable';
    const shards = listOrphanCandidates(
      opened.directory,
      'directory',
      (name) => shardPattern.test(name),
      gcLabel,
    );
    if (shards.status === 'unreadable') return 'root_unusable';

    const folders: { readonly directory: GuardedDirectory; readonly accept: RegExp }[] = [];
    for (const shard of shards.candidates) {
      const child = childDirectory(opened.directory, shard.name, gcLabel);
      if (child.status === 'ready') {
        folders.push({
          directory: child.directory,
          accept: new RegExp(`^${shard.name}[0-9a-f]{62}\\.json$`),
        });
      }
    }
    const temps = childDirectory(opened.directory, 'incoming', gcLabel);
    if (temps.status === 'ready')
      folders.push({ directory: temps.directory, accept: temporaryPattern });

    const candidates: OrphanCandidate[] = [];
    for (const folder of folders) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const listed = listOrphanCandidates(
        folder.directory,
        'file',
        (name) => folder.accept.test(name),
        gcLabel,
      );
      if (listed.status === 'unreadable') return 'root_unusable';
      candidates.push(...listed.candidates);
    }
    return candidates;
  };

  // The one place liveness is decided, inside the collector's synchronous per-candidate step.
  const isLiveContent = (candidate: OrphanCandidate, mark: ReadonlySet<string>) => {
    if (temporaryPattern.test(candidate.name)) return liveTemps.has(candidate.name);
    const hash = candidate.name.slice(0, 64);
    return held.has(hash) || (releasedDuringSweep?.has(hash) ?? false) || mark.has(hash);
  };

  const collectGarbage = async (input: ContentGcInput): Promise<ContentGcResult> => {
    if (sweeping) return { status: 'skipped', reason: 'already_running' };
    sweeping = true;
    try {
      const listed = await listCandidates();
      if (listed === 'absent') return { status: 'skipped', reason: 'nothing_old' };
      if (listed === 'root_unusable') return { status: 'skipped', reason: 'root_unusable' };

      // Age only. Whether a candidate is held, referenced or live is decided in the sweep step.
      const old: OrphanCandidate[] = [];
      for (const candidate of listed) {
        try {
          const { mtimeMs } = await lstat(candidate.path);
          if (input.nowMs - mtimeMs >= input.minAgeMs) old.push(candidate);
        } catch {
          // Gone or unreadable: not a candidate this time.
        }
      }
      if (old.length === 0) return { status: 'skipped', reason: 'nothing_old' };

      // Adjacent and synchronous: tracking starts before the mark is read, so a capture that
      // commits and releases after the read is still kept by this sweep.
      releasedDuringSweep = new Set();
      const mark = input.referencedHashes();

      const stats = await sweepOrphans({
        label: 'workflow content file',
        candidates: old,
        isLive: (candidate) => isLiveContent(candidate, mark),
        minAgeMs: input.minAgeMs,
        nowMs: input.nowMs,
      });
      return { status: 'swept', stats };
    } finally {
      releasedDuringSweep = null;
      sweeping = false;
    }
  };

  return {
    service: {
      openCapture,

      open: (ref) => verifiedPathFor(ref).pipe(Effect.map((path) => createReadStream(path))),

      /**
       * One read, then verify the buffer that read produced.
       *
       * Deliberately not `verifiedPathFor` plus a second read. `open` pre-verifies because it cannot
       * verify while streaming; a whole-value read is already holding the bytes it needs to hash, so
       * pre-verifying would double the IO to buy nothing. The "verified on every read" invariant is
       * identical either way.
       */
      readAll: (ref) =>
        reading(ref, async (path) => {
          const bytes = await readFile(path);
          if (`sha256:${sha256(bytes)}` !== ref) {
            throw new ContentUnavailable({ ref, cause: 'corrupt' });
          }
          return bytes;
        }),
    },
    collectGarbage,
  };
}

function closedCapture() {
  return new ContentPublishError({
    message: 'The checkpoint capture has closed, so its content can no longer be published.',
  });
}

async function verifies(path: string, ref: string): Promise<boolean> {
  try {
    return `sha256:${await hashFile(path)}` === ref;
  } catch {
    return false;
  }
}

/** Hashes a file without holding it in memory, so verification costs a read and not a copy. */
async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
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
