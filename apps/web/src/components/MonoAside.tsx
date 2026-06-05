import type { ReactNode } from 'react';

/**
 * The mono whisper — a low-opacity monospace aside used as the author's
 * signature on a surface (empty states, the palette footer, tips). Centralizes
 * the size/opacity so every whisper sounds the same.
 */
export function MonoAside({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p className={`font-mono text-[12px] text-fg-subtle opacity-55 ${className}`}>{children}</p>
  );
}
