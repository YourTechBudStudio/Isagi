import type { ReactNode } from 'react';

export type ChipTone = 'command' | 'crumb';

const TONE: Record<ChipTone, string> = {
  command: 'border-blue/30 bg-blue/10 text-blue',
  crumb: 'border-line/22 bg-white/6 text-fg-muted',
};

/**
 * A small mono token used in the command palette: the active command reads as a
 * `command` chip, accepted wizard steps trail behind it as `crumb` chips. One
 * padding scale so the breadcrumb row stays even.
 */
export function Chip({
  tone = 'crumb',
  children,
  className = '',
}: {
  tone?: ChipTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`rounded-md border px-2 py-1 font-mono text-[11.5px] ${TONE[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
