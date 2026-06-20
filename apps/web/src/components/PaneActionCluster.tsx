import { PanelBottom, PanelRight, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';

import { Tooltip } from './Tooltip.js';

/**
 * Quiet pane action affordances: a bottom-right cluster that stays out of the
 * work surface until the pane is hovered or focused. Callers keep ownership of
 * focus and command dispatch; this component is only chrome.
 */
export function PaneActionCluster({
  onSplitRight,
  onSplitDown,
  onDelete,
  className = '',
}: {
  onSplitRight: () => void;
  onSplitDown: () => void;
  onDelete: () => void;
  className?: string;
}) {
  return (
    <div
      className={`absolute right-2 bottom-2 z-10 flex items-center gap-1 rounded-sm border border-line/20 bg-elevated/70 p-1 opacity-0 shadow-soft backdrop-blur-sm transition duration-micro ease-expo group-focus-within:opacity-100 group-hover:opacity-100 focus-within:opacity-100 ${className}`}
    >
      <PaneActionButton label="Split pane right" onClick={onSplitRight}>
        <PanelRight size={13} />
      </PaneActionButton>
      <PaneActionButton label="Split pane down" onClick={onSplitDown}>
        <PanelBottom size={13} />
      </PaneActionButton>
      <PaneActionButton label="Delete pane" danger onClick={onDelete}>
        <Trash2 size={13} />
      </PaneActionButton>
    </div>
  );
}

function PaneActionButton({
  label,
  danger = false,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip label={label} side="left">
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className={`grid size-6 place-items-center rounded-sm border border-transparent text-fg-subtle transition duration-micro ease-expo focus-visible:opacity-100 ${
          danger
            ? 'hover:border-error/40 hover:bg-error/12 hover:text-error'
            : 'hover:border-blue/30 hover:bg-blue/10 hover:text-blue'
        }`}
      >
        {children}
      </button>
    </Tooltip>
  );
}
