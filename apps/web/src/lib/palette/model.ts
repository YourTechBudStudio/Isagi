import { GROUP_ORDER } from './groups.js';
import type { ArgSpec, ArgValues, Option, PaletteContext, PaletteEntry } from './types.js';

/**
 * Empty-query view: show the most-recent few entries **per group** (not one flat
 * list), so every group stays represented. 5–6 per group felt dense across four
 * groups, so we cap at 3; recents float to the top of their group, then the
 * natural assembly order fills the rest. Recency is tracked in the palette store.
 */
const PER_GROUP_LIMIT = 3;

export function filterEntries(entries: readonly PaletteEntry[], query: string): PaletteEntry[] {
  const q = query.toLowerCase();
  return entries.filter((entry) => `${entry.label} ${entry.sub ?? ''}`.toLowerCase().includes(q));
}

export function recencyView(
  entries: readonly PaletteEntry[],
  recents: readonly string[],
): PaletteEntry[] {
  const rank = new Map(recents.map((id, index) => [id, index] as const));
  const out: PaletteEntry[] = [];
  for (const group of GROUP_ORDER) {
    const inGroup = entries
      .filter((entry) => entry.group === group)
      .sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
    out.push(...inGroup.slice(0, PER_GROUP_LIMIT));
  }
  return out;
}

export function computeStepOptions(
  spec: ArgSpec,
  options: readonly Option[],
  query: string,
): Option[] {
  const q = query.toLowerCase();
  let result = q
    ? options.filter(
        (option) =>
          (option.label ?? option.value).toLowerCase().includes(q) ||
          option.value.toLowerCase().includes(q),
      )
    : [...options];

  if (spec.kind === 'combo' && query) {
    const proposed = `${spec.prefix ?? ''}${query}`;
    const exists = options.some(
      (option) =>
        option.value.toLowerCase() === proposed.toLowerCase() || option.value.toLowerCase() === q,
    );
    if (!exists) {
      result = [{ value: proposed, create: true, hint: 'new worktree' }, ...result];
    }
  }
  return result;
}

export function defaultOptionIndex(options: readonly Option[]): number {
  const index = options.findIndex((option) => option.isDefault);
  return index >= 0 ? index : 0;
}

export function firstUnfilledStep(args: readonly ArgSpec[], values: ArgValues): number {
  const index = args.findIndex((arg) => values[arg.key] === undefined);
  return index >= 0 ? index : Math.max(args.length - 1, 0);
}

export function labelForValue(
  spec: ArgSpec,
  value: string,
  ctx: PaletteContext,
  values: ArgValues,
): string {
  if (spec.kind === 'text') {
    return value;
  }

  const option = spec.options(ctx, values).find((candidate) => candidate.value === value);
  return option?.label ?? value;
}
