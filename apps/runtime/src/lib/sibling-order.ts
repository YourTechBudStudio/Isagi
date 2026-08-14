/**
 * The one movement rule shared by every reorderable sibling list: remove the
 * source, insert it before the anchor (or at the end), and hand back the new
 * sequence. Ranks are then a positional detail the caller derives from the
 * index, which is why no repository needs its own arithmetic.
 *
 * Pure by design. Validation, transactions, timestamps, and writes belong to
 * the repositories, so this function assumes its inputs are already legal and
 * contains no fallback for a source or anchor that is not in the list.
 */
export function moveBefore(
  orderedIds: readonly number[],
  sourceId: number,
  beforeId: number | null,
): readonly number[] {
  // "Before itself" is the position it already holds, so the sequence is
  // unchanged. This is a legal product no-op, not an error — and it must not
  // fall through to the append branch, which would silently move the item.
  if (beforeId === sourceId) {
    return orderedIds;
  }
  const remaining = orderedIds.filter((id) => id !== sourceId);
  if (beforeId === null) {
    return [...remaining, sourceId];
  }
  const anchorIndex = remaining.indexOf(beforeId);
  return [...remaining.slice(0, anchorIndex), sourceId, ...remaining.slice(anchorIndex)];
}

/**
 * The rank writes a new sequence implies: position becomes rank, and a row whose
 * stored rank already matches its position is omitted.
 *
 * Omitting unchanged rows is what makes an already-effective move cost zero
 * writes while a migrated block still tied at `0` is repaired by the first real
 * reorder. Kept beside `moveBefore` so all three repositories share one
 * definition of "compact" instead of each keeping its own copy.
 */
export function compactedRankChanges(
  stored: readonly { readonly id: number; readonly sortOrder: number }[],
  ordered: readonly number[],
): readonly { readonly id: number; readonly sortOrder: number }[] {
  const storedRanks = new Map(stored.map((row) => [row.id, row.sortOrder]));
  return ordered.flatMap((id, index) =>
    storedRanks.get(id) === index ? [] : [{ id, sortOrder: index }],
  );
}
