import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open as openFile, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { eq } from 'drizzle-orm';
import { Context, Data, Effect, Layer } from 'effect';

import { DataDirectory, DatabaseError, RuntimeDatabase } from '../../persistence/index.js';
import { workflowPayloads } from '../../persistence/schema.js';

/**
 * Immutable, content-addressed bytes of any media type.
 *
 * A content reference is the plain string `sha256:<64 hex>` — deliberately not a branded type. The
 * same digest legitimately serves both a JSON payload slot and a captured evidence blob, because
 * identical bytes must deduplicate across both uses, and the boundaries where confusing the two
 * would matter refuse the mixup by ownership rather than by type. References are validated by
 * `refPattern` on every read.
 */
const refPattern = /^sha256:[a-f0-9]{64}$/;

export class ContentPublishError extends Data.TaggedError('ContentPublishError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * A reference resolved to nothing usable.
 *
 * `cause` separates the two honest answers: the file is gone, or its bytes no longer hash to the
 * reference. Neither is ever repaired by substituting an empty value — a read needed for execution
 * parks the run, and a read needed for inspection says so in the DTO.
 *
 * One caveat when diagnosing a reported `corrupt`: the JSON layer above also raises it for bytes
 * that verify against their reference but will not parse as JSON, which is a real failure with a
 * different cause. Hashing the blob and finding it intact does not clear the report — check whether
 * the reference was read as a payload slot.
 */
export class ContentUnavailable extends Data.TaggedError('ContentUnavailable')<{
  readonly ref: string;
  readonly cause: 'missing' | 'corrupt';
}> {}

export interface WorkflowContentStoreService {
  /**
   * Publishes bytes and returns the reference that names them.
   *
   * A `Buffer` is hashed in memory and skips the write entirely when the file is already there and
   * verifies. A `Readable` is hashed as it streams to disk, so a multi-megabyte capture never has
   * to be materialised. `mediaTypeHint` is recorded in the catalog row as a publisher hint and is
   * read by no product path; media type is a fact about a *use* of bytes, not about a digest.
   */
  readonly put: (input: {
    readonly source: Readable | Buffer;
    readonly mediaTypeHint: string;
  }) => Effect.Effect<
    { readonly contentRef: string; readonly byteSize: number },
    ContentPublishError | DatabaseError
  >;
  /**
   * Verifies the whole file against its hash, then streams it. Two sequential reads per fetch.
   *
   * The cost is deliberate. A hash can only be confirmed at the last byte, and by then a streaming
   * response has long since sent its status line; aborting a half-sent body would make "corrupt"
   * indistinguishable to the client from a dropped connection. So the file is read once to prove it
   * matches its reference and once to serve it, and a 200 never carries unverified bytes.
   */
  readonly open: (ref: string) => Effect.Effect<Readable, ContentUnavailable>;
  /** Verifies in memory and returns the whole value. What the JSON payload store reads through. */
  readonly readAll: (ref: string) => Effect.Effect<Buffer, ContentUnavailable>;
  /** Catalog metadata for a reference, or `null` when nothing has been published under it. */
  readonly inspect: (
    ref: string,
  ) => Effect.Effect<
    { readonly byteSize: number; readonly createdAt: string } | null,
    DatabaseError
  >;
}

export const WorkflowContentStore = Context.GenericTag<WorkflowContentStoreService>(
  'isagi/WorkflowContentStore',
);

export const WorkflowContentStoreLive = Layer.effect(
  WorkflowContentStore,
  Effect.gen(function* () {
    const directory = yield* DataDirectory;
    const database = yield* RuntimeDatabase;
    return makeWorkflowContentStore(join(directory.paths.root, 'workflow-payloads'), database);
  }),
);

/**
 * Absolute path of a reference's backing file. Test and diagnostic use only.
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

/**
 * The store, independent of how its dependencies are provided.
 *
 * Exported so tests can drive it against a temporary root without standing up the whole layer graph.
 *
 * Every blob lives at `<root>/<first-2-hex>/<hash>.json`, whatever it actually contains. The
 * `.json` suffix on a PNG is a known wart: the name is private to this adapter, references are
 * opaque on the wire, and a second root with a legacy fallback would be a dual system for a
 * cosmetic gain. Renaming it is a one-line change for a future story that resets data roots.
 */
export function makeWorkflowContentStore(
  root: string,
  database: Pick<import('../../persistence/index.js').RuntimeDatabaseService, 'use'>,
): WorkflowContentStoreService {
  const incoming = join(root, 'incoming');
  const pathFor = (ref: string) => contentPathFor(root, ref);

  /**
   * Both publication paths land here: a fully written temp file becomes the blob, or it does not
   * exist at all.
   *
   * The temp is fsynced, renamed, and then the *directory* is fsynced too — without that last step
   * the rename itself can be lost by a crash, leaving a reference in the database pointing at
   * nothing. An existing correct file is reused, which is what makes republishing an identical
   * state boundary cost one hash rather than one file.
   */
  const commitTemporary = async (temporary: string, ref: string) => {
    const path = pathFor(ref);
    const folder = dirname(path);
    try {
      if (await verifies(path, ref)) {
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
      if (await verifies(path, ref)) return;
      throw cause;
    }
  };

  /**
   * Opens a temp file under `<root>/incoming/`.
   *
   * Both paths stage here rather than beside the final blob, so one publication invariant has one
   * implementation and shard folders never hold half-written files. Known and accepted: a temp left
   * by a hard kill or power loss mid-stream is never swept. Every *handled* failure removes its own
   * temp, so the residue is bounded by crash frequency, not by capture frequency, and it joins the
   * orphan class this subsystem already accepts — a complete blob whose owning transaction then
   * failed. Both halves belong to the same future cleanup story; do not add an age-based sweep here.
   */
  const stage = async () => {
    await mkdir(incoming, { recursive: true });
    return join(incoming, `${randomUUID()}.tmp`);
  };

  const putBuffer = async (bytes: Buffer) => {
    const ref = `sha256:${sha256(bytes)}`;
    // Today's fast path, kept because roughly fifteen JSON slots publish through it: an existing
    // file that verifies means there is nothing to write at all.
    if (await verifies(pathFor(ref), ref)) return { contentRef: ref, byteSize: bytes.byteLength };
    const temporary = await stage();
    try {
      await writeFile(temporary, bytes, { flag: 'wx' });
    } catch (cause) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw cause;
    }
    await commitTemporary(temporary, ref);
    return { contentRef: ref, byteSize: bytes.byteLength };
  };

  const putStream = async (source: Readable) => {
    const temporary = await stage();
    const hash = createHash('sha256');
    let byteSize = 0;
    try {
      const measure = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          byteSize += chunk.byteLength;
          callback(null, chunk);
        },
      });
      await pipeline(source, measure, createWriteStream(temporary, { flags: 'wx' }));
    } catch (cause) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw cause;
    }
    const ref = `sha256:${hash.digest('hex')}`;
    await commitTemporary(temporary, ref);
    return { contentRef: ref, byteSize };
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

  return {
    put: ({ source, mediaTypeHint }) =>
      Effect.gen(function* () {
        const published = yield* Effect.tryPromise({
          try: () => (Buffer.isBuffer(source) ? putBuffer(source) : putStream(source)),
          catch: (cause) =>
            new ContentPublishError({ message: 'Could not publish workflow content.', cause }),
        });
        // The metadata row is written after the bytes are durable, so a crash between the two
        // leaves an unreferenced file — acceptable garbage — and never a row describing bytes that
        // are not there.
        yield* database.use('workflow_upsert_payload', (db) => {
          db.insert(workflowPayloads)
            .values({
              payloadRef: published.contentRef,
              byteSize: published.byteSize,
              mediaType: mediaTypeHint,
              createdAt: new Date().toISOString(),
            })
            .onConflictDoNothing({ target: workflowPayloads.payloadRef })
            .run();
        });
        return published;
      }),

    open: (ref) => verifiedPathFor(ref).pipe(Effect.map((path) => createReadStream(path))),

    /**
     * One read, then verify the buffer that read produced.
     *
     * Deliberately not `verifiedPathFor` plus a second read. `open` pre-verifies because it cannot
     * verify while streaming; a whole-value read is already holding the bytes it needs to hash, so
     * pre-verifying would double the IO of every non-inline payload the engine resolves — the wait
     * resolver, segment slots, settlement and the artifact catalog all land here — to buy nothing.
     * The "verified on every read" invariant is identical either way.
     */
    readAll: (ref) =>
      reading(ref, async (path) => {
        const bytes = await readFile(path);
        if (`sha256:${sha256(bytes)}` !== ref) {
          throw new ContentUnavailable({ ref, cause: 'corrupt' });
        }
        return bytes;
      }),

    inspect: (ref) =>
      database.use('workflow_inspect_content', (db) => {
        const row = db
          .select()
          .from(workflowPayloads)
          .where(eq(workflowPayloads.payloadRef, ref))
          .get();
        return row ? { byteSize: row.byteSize, createdAt: row.createdAt } : null;
      }),
  };
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
