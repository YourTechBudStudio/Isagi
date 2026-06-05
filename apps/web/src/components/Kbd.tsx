import type { ReactNode } from 'react';

/**
 * A keyboard hint cap — the single home for shortcut glyphs (`⌘N`, `↵`, `esc`)
 * across buttons, the palette footer, and empty-state asides. One quiet bordered
 * mono pill so every keycap reads the same.
 */
export function Kbd({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={`rounded-md border border-line/35 px-1.5 py-px font-mono text-[10.5px] font-normal text-fg-subtle ${className}`}
    >
      {children}
    </kbd>
  );
}
