import type { ReactNode, Ref } from 'react';

import { AttentionDot } from '../../components/AttentionDot.js';
import type { IconType } from '../../lib/icon.js';
import type { AttentionState } from '../../lib/workspace/types.js';
import type { WithPaneMenu } from './usePaneMenu.js';

/**
 * The chrome every PTY-style pane shares, whatever its body holds: the section root and its focus
 * border, the header (icon, attention dot, title, status label) inside the pane menu, an optional
 * notice bar, and the floating action cluster. One implementation, so a terminal pane and a
 * Fluidcast pane cannot drift.
 */
export function PaneFrame({
  sectionRef,
  title,
  icon: Icon,
  attention,
  statusLabel,
  notice = null,
  focused,
  errored = false,
  dimmed = false,
  locked,
  onFocus,
  withPaneMenu,
  cluster,
  children,
}: {
  readonly sectionRef: Ref<HTMLElement>;
  readonly title: string;
  readonly icon: IconType;
  readonly attention: AttentionState;
  readonly statusLabel: string;
  readonly notice?: string | null;
  readonly focused: boolean;
  readonly errored?: boolean;
  readonly dimmed?: boolean;
  /** A delete owns this pane, so pointer-down must not promote it. */
  readonly locked: boolean;
  readonly onFocus: () => void;
  readonly withPaneMenu: WithPaneMenu;
  /** The pane's `PaneActionCluster`, floated lower-right; omitted when the pane offers none. */
  readonly cluster: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section
      ref={sectionRef}
      aria-label={title}
      tabIndex={-1}
      // Promoting a pane that is being deleted would retarget Cmd+W and the
      // active-pane commands at it. The pane body keeps its own focus either way.
      onPointerDown={locked ? undefined : onFocus}
      className={`group relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-md border bg-elevated/50 backdrop-blur-sm transition-colors duration-ui ease-expo ${
        errored ? 'border-error/35' : focused ? 'border-blue/40' : 'border-line/20'
      } ${dimmed ? 'bg-elevated/38' : ''}`}
    >
      {withPaneMenu(
        <div className="flex min-h-9 items-center gap-2 border-b border-line/15 px-3 py-2">
          <Icon size={13} className="text-fg-subtle" />
          <AttentionDot state={attention} />
          <span className="truncate font-mono text-[11.5px] text-fg-muted">{title}</span>
          <span className="ml-auto truncate font-mono text-[10.5px] text-fg-subtle">
            {statusLabel}
          </span>
        </div>,
      )}
      {notice ? (
        <div className="border-b border-line/12 px-3 py-1.5 font-mono text-[10.5px] text-fg-subtle">
          {notice}
        </div>
      ) : null}
      {children}
      {cluster}
    </section>
  );
}
