import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { open, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { Context, Data, Effect, Layer } from 'effect';

import { DataDirectory, DatabaseError, RuntimeDatabase } from '../../persistence/index.js';
import { workflowPayloads } from '../../persistence/schema.js';
import { canonicalBytes, UnserializableValueError } from '../state/serializable.js';

/**
 * Values at or under this many **UTF-8 bytes** of canonical JSON are stored inline in the row that
 * needs them; anything larger becomes an immutable content-addressed file.
 *
 * The threshold is measured in the same bytes that are stored and hashed, not in JavaScript string
 * length, so a state boundary full of non-ASCII text is classified by its real size.
 */
export const inlinePayloadThresholdBytes = 8192;

export const workflowPayloadMediaType = 'application/json';

/**
 * One recorded value's storage location.
 *
 * Exactly one member is non-null. A slot that was never produced is represented by the *absence* of
 * a `PayloadSlot`, not by a slot with two nulls, which is why this type cannot express that state.
 */
export type PayloadSlot =
  | { readonly inline: string; readonly ref: null }
  | { readonly inline: null; readonly ref: string };

export class PayloadPublishError extends Data.TaggedError('PayloadPublishError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * A reference resolved to nothing usable.
 *
 * `cause` separates the two honest answers: the file is gone, or its bytes no longer hash to the
 * reference. Neither is ever repaired by substituting an empty value — a read needed for execution
 * parks the run, and a read needed for inspection says so in the DTO.
 */
export class PayloadUnavailable extends Data.TaggedError('PayloadUnavailable')<{
  readonly ref: string;
  readonly cause: 'missing' | 'corrupt';
}> {}

export interface WorkflowPayloadStoreService {
  /** Canonicalizes, then returns an inline slot or publishes bytes and returns a reference. */
  readonly publish: (
    value: unknown,
  ) => Effect.Effect<PayloadSlot, PayloadPublishError | DatabaseError>;
  readonly read: (ref: string) => Effect.Effect<unknown, PayloadUnavailable>;
  readonly readMany: (
    refs: readonly string[],
  ) => Effect.Effect<ReadonlyMap<string, unknown>, PayloadUnavailable>;
  /** Resolves a stored slot back to its value, whichever side it landed on. */
  readonly resolve: (slot: PayloadSlot) => Effect.Effect<unknown, PayloadUnavailable>;
  /** Absolute path of a reference's backing file. Test and diagnostic use only. */
  readonly pathOf: (ref: string) => string;
}

export const WorkflowPayloadStore = Context.GenericTag<WorkflowPayloadStoreService>(
  'isagi/WorkflowPayloadStore',
);

const refPattern = /^sha256:[a-f0-9]{64}$/;

export const WorkflowPayloadStoreLive = Layer.effect(
  WorkflowPayloadStore,
  Effect.gen(function* () {
    const directory = yield* DataDirectory;
    const database = yield* RuntimeDatabase;
    const root = join(directory.paths.root, 'workflow-payloads');
    return makeWorkflowPayloadStore(root, database);
  }),
);

/**
 * The store, independent of how its dependencies are provided.
 *
 * Exported so tests can drive it against a temporary root without standing up the whole layer graph.
 */
export function makeWorkflowPayloadStore(
  root: string,
  database: Pick<import('../../persistence/index.js').RuntimeDatabaseService, 'use'>,
): WorkflowPayloadStoreService {
  const pathOf = (ref: string) => {
    const hash = ref.slice('sha256:'.length);
    return join(root, hash.slice(0, 2), `${hash}.json`);
  };

  const read = (ref: string) =>
    Effect.tryPromise({
      try: async () => {
        if (!refPattern.test(ref)) throw new PayloadUnavailable({ ref, cause: 'missing' });
        let bytes: Buffer;
        try {
          bytes = await readFile(pathOf(ref));
        } catch {
          throw new PayloadUnavailable({ ref, cause: 'missing' });
        }
        // Verified on every read. A reference is a claim about bytes, and an unverified read would
        // let a truncated or edited file be presented as recorded history.
        if (`sha256:${sha256(bytes)}` !== ref) {
          throw new PayloadUnavailable({ ref, cause: 'corrupt' });
        }
        try {
          return JSON.parse(bytes.toString('utf8')) as unknown;
        } catch {
          throw new PayloadUnavailable({ ref, cause: 'corrupt' });
        }
      },
      catch: (cause) =>
        cause instanceof PayloadUnavailable
          ? cause
          : new PayloadUnavailable({ ref, cause: 'missing' }),
    });

  return {
    pathOf,
    read,
    readMany: (refs) =>
      Effect.gen(function* () {
        const resolved = new Map<string, unknown>();
        for (const ref of new Set(refs)) {
          resolved.set(ref, yield* read(ref));
        }
        return resolved;
      }),
    resolve: (slot) =>
      slot.ref === null ? Effect.succeed(JSON.parse(slot.inline) as unknown) : read(slot.ref),
    publish: (value) =>
      Effect.gen(function* () {
        const bytes = yield* Effect.try({
          try: () => canonicalBytes(value),
          catch: (cause) =>
            new PayloadPublishError({
              message:
                cause instanceof UnserializableValueError
                  ? cause.message
                  : 'Value could not be canonicalized.',
              cause,
            }),
        });

        if (bytes.byteLength <= inlinePayloadThresholdBytes) {
          return { inline: bytes.toString('utf8'), ref: null } satisfies PayloadSlot;
        }

        const ref = `sha256:${sha256(bytes)}`;
        yield* writeContent(pathOf(ref), bytes, ref);
        // The metadata row is written after the bytes are durable, so a crash between the two
        // leaves an unreferenced file — acceptable garbage — and never a row describing bytes that
        // are not there.
        yield* database.use('workflow_upsert_payload', (db) => {
          db.insert(workflowPayloads)
            .values({
              payloadRef: ref,
              byteSize: bytes.byteLength,
              mediaType: workflowPayloadMediaType,
              createdAt: new Date().toISOString(),
            })
            .onConflictDoNothing({ target: workflowPayloads.payloadRef })
            .run();
        });
        return { inline: null, ref } satisfies PayloadSlot;
      }),
  };
}

/**
 * Publishes bytes so that a reader either sees the complete file or no file at all.
 *
 * Written to a unique temporary name with `wx`, fsynced, renamed, and then the *directory* is
 * fsynced too — without that last step the rename itself can be lost by a crash, leaving a
 * reference in the database pointing at nothing. An existing correct file is reused, which is what
 * makes republishing an identical state boundary cost one hash rather than one file.
 */
function writeContent(path: string, bytes: Buffer, ref: string) {
  return Effect.tryPromise({
    try: async () => {
      const folder = dirname(path);
      try {
        const existing = await readFile(path);
        if (`sha256:${sha256(existing)}` === ref) return;
      } catch {
        // Not present, or unreadable: fall through and republish it.
      }
      await mkdir(folder, { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, bytes, { flag: 'wx' });
        await syncPath(temporary);
        await rename(temporary, path);
        await syncDirectory(folder);
      } catch (cause) {
        await rm(temporary, { force: true }).catch(() => undefined);
        // A concurrent publisher of identical content is a success, not a conflict.
        const winner = await readFile(path).catch(() => null);
        if (winner && `sha256:${sha256(winner)}` === ref) return;
        throw cause;
      }
    },
    catch: (cause) =>
      new PayloadPublishError({ message: 'Could not publish workflow payload.', cause }),
  });
}

async function syncPath(path: string) {
  const handle = await open(path, 'r');
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
