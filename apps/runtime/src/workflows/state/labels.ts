import { isolate } from './isolation.js';

/** The longest display name a row stores. */
export const maxLabelLength = 200;

/**
 * A dynamic display name, captured once when the row it names is created.
 *
 * Labels are cosmetic: a label that throws, returns something other than a non-empty string, or was
 * never declared yields `null`, and the reader falls back to the static title, then the id. A label
 * can never fail a run.
 */
export function captureLabel(
  // A bundle is compiled against its own copy of the SDK, so the argument type is erased by the
  // time a registration reaches the runtime.
  label: ((argument: never) => unknown) | undefined,
  argument: unknown,
): string | null {
  if (typeof label !== 'function') return null;
  let produced: unknown;
  try {
    produced = label(isolate(argument) as never);
  } catch {
    return null;
  }
  if (typeof produced !== 'string' || produced.length === 0) return null;
  if (produced.length <= maxLabelLength) return produced;
  // Never cut a surrogate pair in half: a lone surrogate is not valid UTF-8.
  const lastCode = produced.charCodeAt(maxLabelLength - 1);
  const splitsPair = lastCode >= 0xd800 && lastCode <= 0xdbff;
  return produced.slice(0, splitsPair ? maxLabelLength - 1 : maxLabelLength);
}
