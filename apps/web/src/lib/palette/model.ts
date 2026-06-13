import { GROUP_ORDER } from './groups.js';
import type {
  ArgPayloads,
  ArgSpec,
  ArgValues,
  Option,
  PaletteContext,
  PaletteCommand,
  PaletteEntry,
  ReviewChoice,
} from './types.js';

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
      result = [
        { value: proposed, create: true, hint: spec.createHint ?? 'new worktree' },
        ...result,
      ];
    }
  }
  return result;
}

export function defaultOptionIndex(spec: ArgSpec, options: readonly Option[]): number | null {
  if ((spec.kind === 'select' || spec.kind === 'combo') && spec.defaultSelection === 'none') {
    return null;
  }

  const index = options.findIndex((option) => option.isDefault);
  return index >= 0 ? index : options.length > 0 ? 0 : null;
}

export function firstUnfilledStep(args: readonly ArgSpec[], values: ArgValues): number {
  const index = args.findIndex((arg) => values[arg.key] === undefined);
  return index >= 0 ? index : Math.max(args.length - 1, 0);
}

function isSkipped(
  arg: ArgSpec | undefined,
  ctx: PaletteContext,
  values: ArgValues,
  payloads: ArgPayloads,
): boolean {
  return arg?.kind === 'select' ? (arg.skip?.(ctx, values, payloads) ?? false) : false;
}

/**
 * The next step index at or after `from` that isn't skipped given the current
 * values/payloads. Returns `args.length` when every remaining step is skipped
 * (meaning the wizard should finish).
 */
export function nextVisibleStep(
  args: readonly ArgSpec[],
  from: number,
  ctx: PaletteContext,
  values: ArgValues,
  payloads: ArgPayloads,
): number {
  let index = from;
  while (index < args.length && isSkipped(args[index], ctx, values, payloads)) {
    index += 1;
  }
  return index;
}

/** The previous visible step index before `from`, or `null` if there is none. */
export function prevVisibleStep(
  args: readonly ArgSpec[],
  from: number,
  ctx: PaletteContext,
  values: ArgValues,
  payloads: ArgPayloads,
): number | null {
  let index = from - 1;
  while (index >= 0 && isSkipped(args[index], ctx, values, payloads)) {
    index -= 1;
  }
  return index >= 0 ? index : null;
}

export function labelForValue(
  spec: ArgSpec,
  value: string,
  ctx: PaletteContext,
  values: ArgValues,
): string {
  if (spec.kind === 'text' || spec.kind === 'path' || spec.kind === 'review') {
    return value;
  }

  const options = spec.options(ctx, values);
  if (options instanceof Promise) {
    return value;
  }

  const option = options.find((candidate) => candidate.value === value);
  return option?.label ?? value;
}

export function commandForEntryId(
  entries: readonly PaletteEntry[],
  entryId: string | null,
): { readonly entryId: string; readonly command: PaletteCommand } | null {
  if (!entryId) {
    return null;
  }
  const entry = entries.find((candidate) => candidate.id === entryId);
  return entry?.command ? { entryId: entry.id, command: entry.command } : null;
}

export function reviewChoiceCancels(choice: ReviewChoice): boolean {
  return choice.intent === 'cancel';
}
