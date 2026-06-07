import type { AccentColor } from '../../lib/workspace/types.js';

const ACCENT_BG: Record<AccentColor, string> = {
  blue: 'bg-blue',
  violet: 'bg-violet',
  amber: 'bg-amber',
  green: 'bg-green',
  cyan: 'bg-cyan',
  red: 'bg-red',
};

const BASE = 'grid size-4.5 place-items-center rounded-[5px] font-mono text-[9px] font-bold';

/**
 * A project's rail glyph — the small lettered square that sits at the head of a
 * project's row. Two variants: `connected` (the project's accent fill) and
 * `disconnected` (a dashed error outline). Both live here so the Active and
 * Disconnected sections of the rail can't drift apart visually.
 */
export function ProjectGlyph(
  props: { glyph: string } & ({ accent: AccentColor } | { disconnected: true }),
) {
  const variant =
    'disconnected' in props
      ? 'border border-dashed border-error/55 text-error'
      : `text-canvas ${ACCENT_BG[props.accent]}`;
  return <span className={`${BASE} ${variant}`}>{props.glyph}</span>;
}
