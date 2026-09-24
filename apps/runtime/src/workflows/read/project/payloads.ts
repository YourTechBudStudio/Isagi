import { eq } from 'drizzle-orm';

import type { WorkflowPayloadSlot } from '@isagi/contracts';

import type { RuntimeDrizzleDatabase } from '../../../persistence/database.service.js';
import { workflowPayloads } from '../../../persistence/schema.js';
import { workflowPayloadMediaType, type PayloadSlot } from '../../persistence/payload-store.js';
import { slotFromColumns } from '../../persistence/slots.js';

/**
 * Turning a stored slot into the reference a client receives.
 *
 * Three states stay distinguishable all the way to the wire: a slot that was never produced is
 * `null`, a produced value that fits inline travels as `{ inline }` — including when that value is
 * JSON `null` — and anything larger travels as an opaque sized reference. A client never receives a
 * filesystem path, so #45 can replace the physical store without touching this contract.
 */

/** A row whose metadata is gone is a corrupt database, not a zero-byte payload. */
export class MissingPayloadMetadataError extends Error {
  readonly _tag = 'MissingPayloadMetadataError';
  constructor(readonly payloadRef: string) {
    super(
      `Payload ${payloadRef} is referenced by a workflow record but has no metadata row, so its size and media type cannot be reported.`,
    );
  }
}

/** Inline bytes that will not parse mean the row was written by something that bypassed the store. */
export class CorruptInlinePayloadError extends Error {
  readonly _tag = 'CorruptInlinePayloadError';
  constructor(
    readonly slotName: string,
    readonly detail: string,
  ) {
    super(`Inline payload in ${slotName} is not readable JSON: ${detail}`);
  }
}

export function slotDto(
  db: RuntimeDrizzleDatabase,
  slotName: string,
  slot: PayloadSlot | null,
): WorkflowPayloadSlot {
  if (slot === null) return null;
  if (slot.ref === null) return { inline: parseInline(slotName, slot.inline) };
  const meta = db
    .select()
    .from(workflowPayloads)
    .where(eq(workflowPayloads.payloadRef, slot.ref))
    .get();
  if (!meta) throw new MissingPayloadMetadataError(slot.ref);
  // The catalog row answers for size and for the guard above, never for media type: `media_type` is
  // the publisher's hint about one *use* of those bytes, and the same digest can be a JSON slot here
  // and a `text/plain` evidence capture elsewhere. A slot is always JSON, so it says so.
  return {
    payloadRef: meta.payloadRef,
    byteSize: meta.byteSize,
    mediaType: workflowPayloadMediaType,
  };
}

export function columnSlotDto(
  db: RuntimeDrizzleDatabase,
  slotName: string,
  inline: string | null,
  ref: string | null,
): WorkflowPayloadSlot {
  return slotDto(db, slotName, slotFromColumns(slotName, inline, ref));
}

/**
 * The value behind a slot, but only when it is already inline.
 *
 * Used where a projection needs to look *inside* a recorded value — the destination an edge chose,
 * the questions a human gate asked, a diagnostic's code. Capture runs inside the write transaction,
 * where reading the payload store's files is not available, so an out-of-line value yields `null`
 * rather than a guess. Every such value stays retrievable in full through its own slot.
 */
export function inlineValue(slotName: string, slot: PayloadSlot | null): unknown {
  if (slot === null || slot.ref !== null) return null;
  return parseInline(slotName, slot.inline);
}

function parseInline(slotName: string, inline: string): unknown {
  try {
    return JSON.parse(inline) as unknown;
  } catch (cause) {
    throw new CorruptInlinePayloadError(slotName, String(cause));
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
