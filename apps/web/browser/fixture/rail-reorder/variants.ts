/**
 * The unresolved visual mechanics, split into the axes they actually vary on.
 *
 * The plan lists five variants to compare, but they are not five alternatives —
 * they are three independent choices (how the travelling preview is shaped, what
 * the source leaves behind, and whether siblings hold still), plus a colour
 * question the plan treated as settled and this fixture reopens. Modelling them
 * as axes means every combination is reachable, including ones nobody thought to
 * enumerate, and it is less code than five bespoke mock-ups.
 */

/** How the travelling preview is shaped. */
export type OverlayVariant = 'compact' | 'full';

/** What the source leaves behind in the list. */
export type PlaceholderVariant = 'hold' | 'ghost' | 'collapse';

/** Whether siblings hold still behind a guide, or open a gap. */
export type SiblingVariant = 'stable' | 'reflow';

/**
 * Cyan is the plan's settled choice. It is offered against blue because
 * `--color-waiting` *is* `--color-cyan`: the rail is full of attention dots
 * where cyan already means "waiting on you", and the rail's own structural
 * accent is blue. Judge the guide next to live attention dots before keeping it.
 */
export type GuideTone = 'cyan' | 'blue';

export type HeightPreset = 'short' | 'tall' | 'full';

export interface Variants {
  readonly overlay: OverlayVariant;
  readonly placeholder: PlaceholderVariant;
  readonly siblings: SiblingVariant;
  readonly tone: GuideTone;
  readonly height: HeightPreset;
  /** When set, the next successful drop is rejected so rollback can be judged. */
  readonly failNextDrop: boolean;
}

/** The user's selections so far, so the fixture opens in the chosen treatment. */
export const DEFAULT_VARIANTS: Variants = {
  overlay: 'compact',
  placeholder: 'hold',
  siblings: 'reflow',
  tone: 'cyan',
  height: 'full',
  failNextDrop: false,
};

export const HEIGHT_PX: Record<HeightPreset, number | null> = {
  short: 380,
  tall: 640,
  full: null,
};

/**
 * Live reflow already communicates the destination by opening the gap, and a
 * source that kept its footprint would open a second one. The axes are not
 * fully orthogonal, and pretending otherwise would let the user compare a
 * combination that cannot ship.
 */
export function effectivePlaceholder(variants: Variants): PlaceholderVariant {
  return variants.siblings === 'reflow' ? 'collapse' : variants.placeholder;
}
