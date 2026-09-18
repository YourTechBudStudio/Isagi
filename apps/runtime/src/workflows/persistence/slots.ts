import type { PayloadSlot } from './payload-store.js';

/**
 * The three states a recorded value can be in, and how they map onto a column pair.
 *
 * | Meaning              | `<name>_inline` | `<name>_ref` |
 * | -------------------- | --------------- | ------------ |
 * | never produced       | `NULL`          | `NULL`       |
 * | produced, small      | canonical JSON  | `NULL`       |
 * | produced, large      | `NULL`          | `sha256:…`   |
 *
 * A value that *is* JSON `null` is produced: the inline column holds the four bytes `null`. Keeping
 * "no value" and "the value null" distinguishable is what lets an outcome say it produced nothing
 * versus produced nothing-in-particular, and the read model shows the difference.
 */
export interface SlotColumns {
  readonly inline: string | null;
  readonly ref: string | null;
}

/** An unproduced slot is `null`, which is why both columns going null is representable here. */
export function slotColumns(slot: PayloadSlot | null | undefined): SlotColumns {
  if (!slot) return { inline: null, ref: null };
  return { inline: slot.inline, ref: slot.ref };
}

export class MalformedSlotError extends Error {
  readonly _tag = 'MalformedSlotError';
  constructor(readonly slotName: string) {
    super(
      `Payload slot "${slotName}" has both an inline value and a reference, which no reader can resolve.`,
    );
  }
}

/**
 * Reads a column pair back into a slot.
 *
 * The database CHECK already forbids a both-populated pair, so reaching the throw means a row was
 * written by something that bypassed both the constraint and this module. Failing loudly beats
 * silently preferring one side, because silently preferring one side is how a run would resume from
 * the wrong operand.
 */
export function slotFromColumns(
  slotName: string,
  inline: string | null,
  ref: string | null,
): PayloadSlot | null {
  if (inline !== null && ref !== null) throw new MalformedSlotError(slotName);
  if (ref !== null) return { inline: null, ref };
  if (inline !== null) return { inline, ref: null };
  return null;
}
