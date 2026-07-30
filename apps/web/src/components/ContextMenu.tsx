import { ContextMenu as BaseContextMenu } from '@base-ui/react/context-menu';
import { useEffect, useRef, useState, type ReactElement } from 'react';

import type { IconType } from '../lib/icon.js';
import { didPendingActionSettleSuccessfully } from './context-menu-state.js';

export interface ContextMenuItem {
  readonly label: string;
  readonly icon?: IconType;
  /** Destructive items read red and carry the only accent in the menu. */
  readonly danger?: boolean;
  /**
   * This item's pending and failure states land in the menu, so clicking it does
   * not dismiss the popup immediately. Declared statically rather than inferred
   * from `pending`, because the click that starts the work is handled before the
   * pending state can arrive. A successful settlement closes the menu.
   */
  readonly keepsMenuOpen?: boolean;
  /**
   * This item's action is running. The menu stays open and inert until it
   * settles, and this row carries the sweep.
   */
  readonly pending?: boolean;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
}

/**
 * Themed right-click menu over Base UI — a layered-glass surface that lands on
 * the expo-out curve, matching the command palette. This is working chrome:
 * keep item labels plain and factual, and reserve the `danger` tone for genuine
 * destruction. Wrap the right-clickable element as `children`; Base UI merges
 * the trigger props onto it.
 *
 * When an item is `pending` the popup becomes the action surface: it holds open
 * through the operation (Escape and outside-press are ignored), every row goes
 * inert, and the running item draws the same sweep the command palette uses. It
 * stays open for a failure too, which is why `error` is rendered here rather
 * than displaced into a toast. A successful settlement explicitly starts the
 * popup's shorter exit while the deleted target begins its surface-scale exit —
 * see ADR 0004.
 */
export function ContextMenu({
  children,
  items,
  error = null,
  onResultDismissed,
}: {
  children: ReactElement;
  items: readonly ContextMenuItem[];
  /** Failure from the last action, shown in the popup that owns the result. */
  error?: string | null;
  /** The popup is done with `error`; callers should drop it. */
  onResultDismissed?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const pending = items.some((item) => item.pending);
  const previouslyPending = useRef(pending);

  useEffect(() => {
    const settledSuccessfully = didPendingActionSettleSuccessfully({
      previouslyPending: previouslyPending.current,
      pending,
      error,
    });
    previouslyPending.current = pending;
    if (settledSuccessfully) setOpen(false);
  }, [error, pending]);

  return (
    <BaseContextMenu.Root
      open={open}
      onOpenChange={(next) => {
        // Closing mid-flight would take the only running indicator off screen
        // and leave the target inert with nothing to explain it.
        if (!next && pending) return;
        setOpen(next);
        // Drop the previous result on the way out — and on the way back in, so a
        // stale failure never greets a fresh right-click.
        if (!next || error) onResultDismissed?.();
      }}
    >
      <BaseContextMenu.Trigger render={children} />
      <BaseContextMenu.Portal>
        <BaseContextMenu.Positioner className="z-50 outline-none">
          <BaseContextMenu.Popup className="origin-(--transform-origin) min-w-44 rounded-md border border-line/30 bg-elevated/90 p-1 shadow-soft backdrop-blur-xl transition-[opacity,transform] duration-ui ease-expo data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
            {items.map((item) => {
              const Icon = item.icon;
              const inert = item.disabled || pending;
              return (
                <BaseContextMenu.Item
                  key={item.label}
                  onClick={item.onSelect}
                  disabled={inert}
                  closeOnClick={!item.keepsMenuOpen}
                  className={`relative flex cursor-default items-center gap-2.5 overflow-hidden rounded-sm px-2.5 py-1.75 text-[12.5px] outline-none transition-opacity duration-ui ease-expo select-none ${
                    item.danger
                      ? 'text-error data-highlighted:bg-error/12'
                      : 'text-fg-muted data-highlighted:bg-white/8 data-highlighted:text-fg'
                  } ${inert && !item.pending ? 'opacity-40' : ''}`}
                >
                  {Icon && <Icon size={14} className="shrink-0" />}
                  <span className="truncate">{item.label}</span>
                  {item.pending && (
                    <span
                      aria-hidden
                      className="command-sweep command-sweep-danger command-sweep-pinned"
                    />
                  )}
                </BaseContextMenu.Item>
              );
            })}
            {error && (
              <p
                role="status"
                className="mt-1 border-t border-line/15 px-2.5 pt-2 pb-1 font-mono text-[10.5px] leading-relaxed text-error"
              >
                {error}
              </p>
            )}
          </BaseContextMenu.Popup>
        </BaseContextMenu.Positioner>
      </BaseContextMenu.Portal>
    </BaseContextMenu.Root>
  );
}
