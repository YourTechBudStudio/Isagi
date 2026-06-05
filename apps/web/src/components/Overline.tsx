import type { ReactNode } from 'react';

/**
 * A quiet uppercase section label — the typographic overline. Used for rail
 * group headers, palette group dividers, and edge-state eyebrows. Letter-spacing
 * and case are intentional per the design system.
 */
export function Overline({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      className={`font-mono text-[10px] tracking-widest text-fg-subtle uppercase ${className}`}
    >
      {children}
    </p>
  );
}
