import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';
import type { ReactElement } from 'react';

type TooltipSide = 'top' | 'bottom' | 'left' | 'right';

/**
 * Themed tooltip over Base UI — a quiet mono "terminal chip" on a deep fill that
 * lands on the expo-out curve. Used for terse, factual labels (attention states,
 * kbd hints, action buttons). Keep copy dry: this is working chrome, not a place
 * for humour.
 *
 * Wrap a single trigger element as `children`; Base UI merges its accessibility
 * and event props onto it. Share the open/close delay via `TooltipDelayProvider`.
 */
export function Tooltip({
  label,
  children,
  side = 'bottom',
}: {
  label: string;
  children: ReactElement;
  side?: TooltipSide;
}) {
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner className="z-50" side={side} sideOffset={8}>
          <BaseTooltip.Popup className="origin-(--transform-origin) rounded-sm border border-line/40 bg-canvas/90 px-2.5 py-1.25 font-mono text-[10.5px] tracking-wide text-fg-muted shadow-soft backdrop-blur-md transition-[opacity,transform] duration-ui ease-expo data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0">
            {label}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}

/**
 * Shares one hover delay across all tooltips, so moving between adjacent
 * triggers feels instant rather than re-arming the delay each time. Mount once
 * near the shell root.
 */
export function TooltipDelayProvider({ children }: { children: ReactElement }) {
  return (
    <BaseTooltip.Provider delay={180} closeDelay={0}>
      {children}
    </BaseTooltip.Provider>
  );
}
