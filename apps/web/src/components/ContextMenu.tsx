import { ContextMenu as BaseContextMenu } from '@base-ui/react/context-menu';
import type { ReactElement } from 'react';

import type { IconType } from '../lib/icon.js';

export interface ContextMenuItem {
  readonly label: string;
  readonly icon?: IconType;
  /** Destructive items read red and carry the only accent in the menu. */
  readonly danger?: boolean;
  readonly onSelect: () => void;
}

/**
 * Themed right-click menu over Base UI — a layered-glass surface that lands on
 * the expo-out curve, matching the command palette. This is working chrome:
 * keep item labels plain and factual, and reserve the `danger` tone for genuine
 * destruction. Wrap the right-clickable element as `children`; Base UI merges
 * the trigger props onto it.
 */
export function ContextMenu({
  children,
  items,
}: {
  children: ReactElement;
  items: readonly ContextMenuItem[];
}) {
  return (
    <BaseContextMenu.Root>
      <BaseContextMenu.Trigger render={children} />
      <BaseContextMenu.Portal>
        <BaseContextMenu.Positioner className="z-50 outline-none">
          <BaseContextMenu.Popup className="origin-(--transform-origin) min-w-44 rounded-md border border-line/30 bg-elevated/90 p-1 shadow-soft backdrop-blur-xl transition-[opacity,transform] duration-ui ease-expo data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
            {items.map((item) => {
              const Icon = item.icon;
              return (
                <BaseContextMenu.Item
                  key={item.label}
                  onClick={item.onSelect}
                  className={`flex cursor-default items-center gap-2.5 rounded-sm px-2.5 py-1.75 text-[12.5px] outline-none select-none ${
                    item.danger
                      ? 'text-error data-highlighted:bg-error/12'
                      : 'text-fg-muted data-highlighted:bg-white/8 data-highlighted:text-fg'
                  }`}
                >
                  {Icon && <Icon size={14} className="shrink-0" />}
                  <span className="truncate">{item.label}</span>
                </BaseContextMenu.Item>
              );
            })}
          </BaseContextMenu.Popup>
        </BaseContextMenu.Positioner>
      </BaseContextMenu.Portal>
    </BaseContextMenu.Root>
  );
}
