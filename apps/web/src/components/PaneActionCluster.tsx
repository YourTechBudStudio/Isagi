import { PanelBottom, PanelRight, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';

import { Tooltip } from './Tooltip.js';

/**
 * Quiet pane action affordances: a bottom-right cluster that stays out of the
 * work surface until the pane is hovered or focused. Callers keep ownership of
 * focus and command dispatch; this component is only chrome.
 *
 * While `deletePending` is set the cluster becomes the pane's action surface: it
 * pins visible regardless of hover (otherwise moving the mouse away would take
 * the only running indicator off screen), every button goes inert, and the same
 * sweep the command palette uses runs along the bottom edge in the danger tone.
 * That also gives `Cmd+W` — which has no affordance of its own — somewhere
 * visible to report from.
 */
export function PaneActionCluster({
  onSplitRight,
  onSplitDown,
  onDelete,
  disabled = false,
  deletePending = false,
  className = '',
}: {
  onSplitRight: () => void;
  onSplitDown: () => void;
  onDelete: () => void;
  /** Inert because a delete owned elsewhere is running against this pane. */
  disabled?: boolean;
  /** This cluster started the delete, so it carries the running indicator. */
  deletePending?: boolean;
  className?: string;
}) {
  const inert = disabled || deletePending;

  return (
    <div
      className={`absolute right-2 bottom-2 z-10 flex items-center gap-1 overflow-hidden rounded-sm border border-line/20 bg-elevated/70 p-1 shadow-soft backdrop-blur-sm transition duration-micro ease-expo group-focus-within:opacity-100 group-hover:opacity-100 focus-within:opacity-100 ${
        deletePending ? 'opacity-100' : 'opacity-0'
      } ${className}`}
    >
      <PaneActionButton label="Split pane right" disabled={inert} onClick={onSplitRight}>
        <PanelRight size={13} />
      </PaneActionButton>
      <PaneActionButton label="Split pane down" disabled={inert} onClick={onSplitDown}>
        <PanelBottom size={13} />
      </PaneActionButton>
      {/* The button you pressed stays lit while the other two recede. */}
      <PaneActionButton
        label="Delete pane"
        danger
        disabled={inert}
        dimWhenDisabled={!deletePending}
        onClick={onDelete}
      >
        <Trash2 size={13} className={deletePending ? 'text-error' : ''} />
      </PaneActionButton>
      {deletePending && (
        <span aria-hidden className="command-sweep command-sweep-danger command-sweep-pinned" />
      )}
    </div>
  );
}

function PaneActionButton({
  label,
  danger = false,
  disabled = false,
  dimWhenDisabled = true,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  dimWhenDisabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip label={label} side="left">
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className={`grid size-6 place-items-center rounded-sm border border-transparent text-fg-subtle transition duration-micro ease-expo focus-visible:opacity-100 disabled:cursor-default ${
          danger
            ? 'enabled:hover:border-error/40 enabled:hover:bg-error/12 enabled:hover:text-error'
            : 'enabled:hover:border-blue/30 enabled:hover:bg-blue/10 enabled:hover:text-blue'
        } ${dimWhenDisabled ? 'disabled:opacity-40' : ''}`}
      >
        {children}
      </button>
    </Tooltip>
  );
}
