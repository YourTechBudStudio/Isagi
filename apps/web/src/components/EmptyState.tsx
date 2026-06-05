import type { ReactNode } from 'react';

import { MonoAside } from './MonoAside.js';
import { Overline } from './Overline.js';

type Halo = 'blue' | 'error';

const HALO: Record<Halo, string> = {
  blue: 'from-blue/10',
  error: 'from-error/10',
};

/**
 * The canvas edge-state scaffold — a soft accent halo behind a centered column.
 * Every "nothing here" / "can't do this" surface composes from the same slots
 * (eyebrow → title → body → actions → aside) so they stay one family. Negative
 * space is the point; only fill the slots a state actually needs.
 */
export function EmptyState({
  icon,
  eyebrow,
  title,
  body,
  actions,
  aside,
  children,
  halo = 'blue',
  wide = false,
}: {
  icon?: ReactNode;
  eyebrow?: string;
  title: ReactNode;
  body?: ReactNode;
  actions?: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
  halo?: Halo;
  wide?: boolean;
}) {
  return (
    <div className="relative grid h-full place-items-center overflow-hidden">
      <div
        className={`pointer-events-none absolute size-160 rounded-full bg-radial ${HALO[halo]} to-transparent to-60%`}
      />
      <div
        className={`relative flex flex-col items-center gap-3.5 text-center ${wide ? 'max-w-[50ch]' : 'max-w-[44ch]'}`}
      >
        {icon}
        {eyebrow && <Overline className="text-[11px] tracking-[0.12em]">{eyebrow}</Overline>}
        <h1 className="font-display text-[27px] font-semibold tracking-[-0.03em] text-fg">
          {title}
        </h1>
        {body && <p className="text-[14.5px] leading-relaxed text-fg-muted">{body}</p>}
        {children}
        {actions && <div className="mt-1 flex gap-2.5">{actions}</div>}
        {aside && <MonoAside className="mt-0.5">{aside}</MonoAside>}
      </div>
    </div>
  );
}
