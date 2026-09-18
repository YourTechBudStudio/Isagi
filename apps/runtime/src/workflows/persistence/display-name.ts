/** The longest display name any record will store. Long enough to be useful, short enough that a
 *  runaway author name cannot bloat a row. */
export const maxDisplayNameLength = 200;

/**
 * Normalizes a captured display name on its way into a record.
 *
 * A display name is cosmetic and is captured exactly once, at the commit that creates the record it
 * names — never recomputed by Retry, Resume or a restart, because it is a fact about what the run
 * was doing then rather than a view over current state.
 *
 * This is the persistence half of that rule and nothing more. It does not invoke an author's
 * `label`, and it draws no conclusion about *why* a caller passed null: a label that threw, one that
 * returned the wrong type and one that was never declared all arrive here identically, and the
 * interpreter is what tells them apart and records the diagnostic.
 *
 * Deliberately not trimming whitespace: the author chose the string, and quietly rewriting it would
 * be a naming policy this boundary has no business inventing. An empty string is different — it
 * names nothing, so it is stored as the absence it is.
 */
export function normalizeDisplayName(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.length <= maxDisplayNameLength) return value;
  return truncateWithoutSplittingSurrogate(value, maxDisplayNameLength);
}

/**
 * Truncates without cutting a surrogate pair in half.
 *
 * Slicing at a fixed index can land between the two halves of an astral character — an emoji, or
 * most non-BMB text — and produce a lone surrogate, which is not valid UTF-8 and round-trips
 * through JSON and SQLite as a replacement character. Dropping the orphaned half costs one
 * character and keeps the stored name a valid string.
 */
function truncateWithoutSplittingSurrogate(value: string, limit: number): string {
  const lastCode = value.charCodeAt(limit - 1);
  const isHighSurrogate = lastCode >= 0xd800 && lastCode <= 0xdbff;
  return value.slice(0, isHighSurrogate ? limit - 1 : limit);
}
