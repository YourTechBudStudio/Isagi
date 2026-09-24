import { Context, Data, Effect, Layer } from 'effect';

import type { DatabaseError } from '../../persistence/index.js';
import { canonicalBytes, UnserializableValueError } from '../state/serializable.js';
import {
  ContentUnavailable,
  WorkflowContentStore,
  type WorkflowContentStoreService,
} from './content-store.js';

/**
 * Values at or under this many **UTF-8 bytes** of canonical JSON are stored inline in the row that
 * needs them; anything larger becomes an immutable content-addressed file.
 *
 * The threshold is measured in the same bytes that are stored and hashed, not in JavaScript string
 * length, so a state boundary full of non-ASCII text is classified by its real size.
 */
export const inlinePayloadThresholdBytes = 8192;

/**
 * What a JSON payload slot always is.
 *
 * Reported by the read model instead of the catalog row's `media_type`, because media type is a
 * fact about a *use* of bytes and not about a digest: the same canonical bytes can be an evidence
 * capture published as `text/plain` and a payload slot at the same time.
 */
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

export interface WorkflowPayloadStoreService {
  /** Canonicalizes, then returns an inline slot or publishes bytes and returns a reference. */
  readonly publish: (
    value: unknown,
  ) => Effect.Effect<PayloadSlot, PayloadPublishError | DatabaseError>;
  readonly read: (ref: string) => Effect.Effect<unknown, ContentUnavailable>;
  readonly readMany: (
    refs: readonly string[],
  ) => Effect.Effect<ReadonlyMap<string, unknown>, ContentUnavailable>;
  /** Resolves a stored slot back to its value, whichever side it landed on. */
  readonly resolve: (slot: PayloadSlot) => Effect.Effect<unknown, ContentUnavailable>;
}

export const WorkflowPayloadStore = Context.GenericTag<WorkflowPayloadStoreService>(
  'isagi/WorkflowPayloadStore',
);

export const WorkflowPayloadStoreLive = Layer.effect(
  WorkflowPayloadStore,
  Effect.map(WorkflowContentStore, makeWorkflowPayloadStore),
);

/**
 * JSON values over the byte store.
 *
 * This layer owns canonicalization, the inline threshold and JSON parsing, and nothing else. Where
 * the bytes live, how they are hashed, and the crash ordering that publishes them belong to
 * `WorkflowContentStore`, so there is one adapter underneath both JSON slots and evidence blobs.
 */
export function makeWorkflowPayloadStore(
  content: WorkflowContentStoreService,
): WorkflowPayloadStoreService {
  const read = (ref: string) =>
    content.readAll(ref).pipe(
      Effect.flatMap((bytes) =>
        Effect.try({
          try: () => JSON.parse(bytes.toString('utf8')) as unknown,
          // The bytes verified against their hash, so unparseable content is a value that was
          // published by something other than this store — corrupt, never "missing".
          catch: () => new ContentUnavailable({ ref, cause: 'corrupt' as const }),
        }),
      ),
    );

  return {
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

        const published = yield* content
          .put({ source: bytes, mediaTypeHint: workflowPayloadMediaType })
          .pipe(
            Effect.catchTag('ContentPublishError', (cause) =>
              Effect.fail(
                new PayloadPublishError({ message: 'Could not publish workflow payload.', cause }),
              ),
            ),
          );
        return { inline: null, ref: published.contentRef } satisfies PayloadSlot;
      }),
  };
}
