import { Bot, Pencil, SquareTerminal, Trash2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';

import { AttentionDot } from '../../components/AttentionDot.js';
import { ContextMenu } from '../../components/ContextMenu.js';
import type { ContextMenuItem } from '../../components/ContextMenu.js';
import { surfaceActionsCopy, worktreeActionsCopy } from '../../copy/index.js';
import { EASE_EXPO, surfaceTransition, uiTransition } from '../../lib/motion.js';
import {
  handleDispatchedCommandError,
  useCommandDispatcher,
} from '../../lib/palette/dispatcher.js';
import {
  isDeletePending,
  showsDeleteSweep,
  surfaceDeleteKey,
  useDeleteEntry,
  usePendingDeleteStore,
  useRunDelete,
} from '../../lib/workspace/pending-deletes.js';
import { scopeKey, type RailOrderScope } from '../../lib/workspace/rail-order.js';
import { worktreeSubtitle } from '../../lib/workspace/selectors.js';
import { surfaceSummaryIcon } from '../../lib/workspace/surface-presentation.js';
import type { Worktree, Surface } from '../../lib/workspace/types.js';
import { useRailDragLayer } from './rail-drag-context.js';
import { RailOrderNotice } from './RailOrderNotice.js';

/**
 * One worktree in the rail. When active it expands to show its surfaces as
 * indented rows. Hierarchy = accent spine + neutral lift: a single blue spine
 * (the indent guide) marks the active worktree's path; the active surface gets a
 * neutral light lift. The active worktree itself carries no pill — expansion and
 * a brighter title are signal enough.
 *
 * The surface list is a reorder scope of its own. Only the active worktree's
 * surfaces are on screen at all, so a surface can never even be dragged towards
 * another worktree's list — and if that ever changed, the scope container would
 * still refuse it. This component does not register its *own* drag source: the
 * project group owns that, because it owns the sibling list a worktree moves in.
 */
export function WorktreeBlock({
  projectId,
  worktree,
  active,
  activeSurfaceId,
  onSelectWorktree,
  onSelectSurface,
}: {
  projectId: number;
  worktree: Worktree;
  active: boolean;
  activeSurfaceId: number | null;
  onSelectWorktree: (worktreeId: number) => void;
  onSelectSurface: (worktreeId: number, surfaceId: number) => void;
}) {
  const dispatchCommand = useCommandDispatcher();
  const rail = useRailDragLayer();
  const surfaceScope: RailOrderScope = { kind: 'surfaces', worktreeId: worktree.id };

  const dispatchWorktreeCommand = (
    commandId: 'start-terminal-session' | 'start-agent-session' | 'delete-active-worktree',
  ) => {
    // Selecting makes the clicked row active in the rail; it does not retarget the
    // command. The command resolves its target from the explicit ids below, which
    // win over the dispatcher's (still-active-worktree) context on this same tick.
    onSelectWorktree(worktree.id);
    void dispatchCommand(commandId, {
      projectId: String(projectId),
      worktreeId: String(worktree.id),
    }).catch(handleDispatchedCommandError);
  };

  const menuItems: ContextMenuItem[] = [
    {
      label: worktreeActionsCopy.menu.startTerminal,
      icon: SquareTerminal,
      onSelect: () => dispatchWorktreeCommand('start-terminal-session'),
    },
    {
      label: worktreeActionsCopy.menu.startAgent,
      icon: Bot,
      onSelect: () => dispatchWorktreeCommand('start-agent-session'),
    },
  ];
  if (!worktree.isRoot) {
    menuItems.push({
      label: worktreeActionsCopy.menu.delete,
      icon: Trash2,
      danger: true,
      onSelect: () => dispatchWorktreeCommand('delete-active-worktree'),
    });
  }

  return (
    <div className={worktree.parked ? 'opacity-55 hover:opacity-80' : ''}>
      <ContextMenu items={menuItems}>
        {/* Selection lives on this button, not on the wrapper above: the
            wrapper also contains the surface list, and a click on a surface
            must not double as a click on its worktree. */}
        <button
          type="button"
          onClick={() => onSelectWorktree(worktree.id)}
          aria-current={active ? 'true' : undefined}
          className="block w-full rounded-sm text-left transition duration-micro ease-expo hover:bg-line/14 focus-visible:bg-line/14 focus-visible:outline-none"
        >
          <WorktreeRowBody worktree={worktree} active={active} />
        </button>
      </ContextMenu>

      <AnimatePresence initial={false}>
        {active && (
          <motion.div
            key="surfaces"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={surfaceTransition}
            className="overflow-hidden"
          >
            <div
              data-drag-scope={scopeKey(surfaceScope)}
              className="my-1 ml-5 flex flex-col gap-0.5 border-l-2 border-blue/50 pl-2.75"
            >
              {/* A removed surface collapses on its own; siblings below reflow
                  up while siblings above hold still. */}
              <AnimatePresence initial={false}>
                {worktree.surfaces.map((surface) => (
                  <motion.div
                    key={surface.id}
                    exit={{ height: 0, opacity: 0 }}
                    transition={surfaceTransition}
                    // The clip belongs to the removal animation above, and only
                    // to it. A drag translates this row's content past its own
                    // edges, so leaving the clip on would delete from view the
                    // very rows the drag is moving.
                    className={rail.dragging ? undefined : 'overflow-hidden'}
                  >
                    <RailOrderNotice scope={surfaceScope} id={surface.id} />
                    <div
                      {...rail.sourceProps(surfaceScope, surface.id, () => (
                        <SurfaceRowBody surface={surface} active={false} />
                      ))}
                      className={`cursor-grab ${rail.draggedClass(surfaceScope, surface.id)}`}
                    >
                      <div style={rail.reflowStyle(surfaceScope, surface.id)}>
                        <SurfaceRow
                          worktreeId={worktree.id}
                          surface={surface}
                          active={surface.id === activeSurfaceId}
                          pillId={`surface-pill-${worktree.id}`}
                          onSelect={() => onSelectSurface(worktree.id, surface.id)}
                        />
                      </div>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
              {worktree.surfaces.length === 0 && (
                <p className="py-1 pl-1 font-mono text-[10.5px] text-fg-subtle opacity-60">
                  {'// no surfaces yet'}
                </p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function SurfaceRow({
  worktreeId,
  surface,
  active,
  pillId,
  onSelect,
}: {
  worktreeId: number;
  surface: Surface;
  active: boolean;
  pillId: string;
  onSelect: () => void;
}) {
  const dispatchCommand = useCommandDispatcher();
  // The right-click menu is the only way to delete a surface, so it is always the
  // site that owns the running indicator. The row itself stays visually untouched
  // and only goes unselectable — see ADR 0004.
  const surfaceKey = surfaceDeleteKey(surface.id);
  const surfaceDelete = useDeleteEntry(surfaceKey);
  const deleting = isDeletePending(surfaceDelete);
  const clearDelete = usePendingDeleteStore((state) => state.clearDelete);
  const runDelete = useRunDelete();

  const surfaceValues = {
    worktreeId: String(worktreeId),
    surfaceId: String(surface.id),
    title: surface.title,
  };

  return (
    <ContextMenu
      error={surfaceDelete?.error ?? null}
      onResultDismissed={() => {
        if (surfaceDelete?.error) clearDelete(surfaceKey);
      }}
      items={[
        {
          label: surfaceActionsCopy.menu.rename,
          icon: Pencil,
          disabled: deleting,
          onSelect: () => {
            void dispatchCommand('rename-active-surface', surfaceValues).catch(
              handleDispatchedCommandError,
            );
          },
        },
        {
          label: surfaceActionsCopy.menu.delete,
          icon: Trash2,
          danger: true,
          keepsMenuOpen: true,
          pending: showsDeleteSweep(surfaceDelete, 'menu'),
          disabled: deleting,
          onSelect: () =>
            runDelete({
              key: surfaceKey,
              origin: 'menu',
              commandId: 'delete-active-surface',
              values: surfaceValues,
            }),
        },
      ]}
    >
      <button
        type="button"
        onClick={deleting ? undefined : onSelect}
        aria-current={active ? 'true' : undefined}
        className={`relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors duration-micro ease-expo ${
          active ? 'text-fg' : 'text-fg-muted hover:bg-white/5 hover:text-fg'
        }`}
      >
        {/* the neutral lift slides between rows via shared layout */}
        {active && (
          <motion.span
            layoutId={pillId}
            transition={{ ...uiTransition, ease: EASE_EXPO }}
            className="absolute inset-0 rounded-lg bg-white/8"
          />
        )}
        <SurfaceRowContent surface={surface} active={active} />
      </button>
    </ContextMenu>
  );
}

/**
 * A worktree row's readable content, with nothing actionable in it.
 *
 * Shared with the travelling drag preview. The interactive shell — the button,
 * its hover and focus treatment, and the right-click menu — stays outside, so a
 * preview can never put a second copy of a control on screen. The row's own
 * padding lives here rather than on the button, which is what lets the preview
 * render it at the same density inside the overlay's card.
 */
export function WorktreeRowBody({ worktree, active }: { worktree: Worktree; active: boolean }) {
  return (
    <div className="flex w-full items-center gap-2.5 px-2.5 py-2">
      <AttentionDot state={worktree.attention} />
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-[13px] ${active ? 'font-semibold text-fg' : 'font-medium text-fg-muted'}`}
        >
          {worktree.title}
        </span>
        <span className="mt-0.5 block truncate font-mono text-[10.5px] text-fg-subtle">
          {worktreeSubtitle(worktree)}
        </span>
      </span>
    </div>
  );
}

/**
 * A surface row as the travelling drag preview renders it: the same content and
 * density as the real row, without the button, the menu, or the shared-layout
 * lift that marks the *selected* surface. Duplicating that `layoutId` would give
 * Motion two elements claiming one identity while the preview is on screen.
 */
export function SurfaceRowBody({ surface, active }: { surface: Surface; active: boolean }) {
  return (
    <div className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[12.5px] text-fg-muted">
      <SurfaceRowContent surface={surface} active={active} />
    </div>
  );
}

function SurfaceRowContent({ surface, active }: { surface: Surface; active: boolean }) {
  const Icon = surfaceSummaryIcon(surface.paneKinds);
  return (
    <>
      <span className="relative z-10">
        <AttentionDot state={surface.attention ?? 'idle'} />
      </span>
      <Icon size={14} className={`relative z-10 ${active ? 'text-fg' : 'text-fg-subtle'}`} />
      <span className="relative z-10 truncate">{surface.title}</span>
    </>
  );
}
