import { Plus } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { ReactNode } from 'react';

import { surfaceTransition } from '../../lib/motion.js';
import { usePaletteStore } from '../../lib/palette/store.js';
import { scopeKey, type RailOrderScope } from '../../lib/workspace/rail-order.js';
import type { PresentProject } from '../../lib/workspace/types.js';
import { ProjectGlyph } from './ProjectGlyph.js';
import { useRailDragLayer } from './rail-drag-context.js';
import { RailOrderNotice } from './RailOrderNotice.js';
import { WorktreeBlock, WorktreeRowBody } from './WorktreeBlock.js';

/**
 * One present project's slice of the rail: a quiet group header with the
 * project's accent glyph and a hover-revealed project-scoped Open Worktree
 * affordance, followed by its worktrees. Missing projects are not rendered here — they live
 * in the rail's Disconnected section as a single promoted row (see
 * {@link ./DisconnectedProjectRow}), so this component is present-only and the
 * Rail owns the partition.
 *
 * The worktree list is also a reorder scope. Its container carries the scope
 * key, which is what makes a cross-project move geometrically impossible rather
 * than merely rejected: a worktree dragged over another project never finds its
 * own scope on the ancestor chain under the pointer. The root worktree registers
 * no drag source at all, so it contributes no insertion boundary and nothing can
 * land above it — pinned for free — and it separately claims its own press so
 * the gesture cannot fall through and lift the whole project.
 */
export function ProjectGroup({
  project,
  activeWorktreeId,
  onSelectWorktree,
  activeSurfaceByWorktreeId,
  onSelectSurface,
}: {
  project: PresentProject;
  activeWorktreeId: number | null;
  onSelectWorktree: (projectId: number, worktreeId: number) => void;
  activeSurfaceByWorktreeId: Readonly<Record<number, number>>;
  onSelectSurface: (worktreeId: number, surfaceId: number) => void;
}) {
  const openPalette = usePaletteStore((state) => state.openPalette);
  const rail = useRailDragLayer();
  const scope: RailOrderScope = { kind: 'worktrees', projectId: project.id };

  return (
    <div className="group/group">
      <ProjectHeaderBody
        project={project}
        action={
          // Nested controls keep their own press semantics: the drag engine
          // refuses to start a gesture from anything inside `data-no-drag`.
          <button
            type="button"
            data-no-drag
            title="Open worktree"
            onClick={() => openPalette('open-worktree', { projectId: String(project.id) })}
            className="ml-auto grid size-5 place-items-center rounded-md text-fg-subtle opacity-0 transition group-hover/group:opacity-100 hover:bg-blue/15 hover:text-blue"
          >
            <Plus size={14} />
          </button>
        }
      />

      {/* A removed worktree collapses in place; the rows below reflow up
          naturally, and the rows above stay put. */}
      <div data-drag-scope={scopeKey(scope)}>
        <AnimatePresence initial={false}>
          {project.worktrees.map((worktree) => (
            <motion.div
              key={worktree.id}
              exit={{ height: 0, opacity: 0 }}
              transition={surfaceTransition}
              // The clip belongs to the removal animation above, and only to it.
              // A drag translates this row's content past its own edges, so
              // leaving the clip on would delete from view the very rows the
              // drag is moving. Nothing is being removed mid-gesture.
              className={rail.dragging ? undefined : 'overflow-hidden'}
            >
              <RailOrderNotice scope={scope} id={worktree.id} />
              <div
                {...(worktree.isRoot
                  ? rail.pinnedProps()
                  : rail.sourceProps(scope, worktree.id, () => (
                      <WorktreeRowBody worktree={worktree} active={false} />
                    )))}
                className={
                  // The root reads as immovable before it is touched: an
                  // ordinary cursor among grab cursors. Trying anyway gets the
                  // refusal cursor, and nothing else.
                  worktree.isRoot
                    ? 'cursor-default'
                    : `cursor-grab ${rail.draggedClass(scope, worktree.id)}`
                }
              >
                <div style={rail.reflowStyle(scope, worktree.id)}>
                  <WorktreeBlock
                    projectId={project.id}
                    worktree={worktree}
                    active={worktree.id === activeWorktreeId}
                    activeSurfaceId={
                      activeSurfaceByWorktreeId[worktree.id] ?? worktree.activeSurfaceId
                    }
                    onSelectWorktree={(worktreeId) => onSelectWorktree(project.id, worktreeId)}
                    onSelectSurface={onSelectSurface}
                  />
                </div>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

/**
 * The project header. Its readable content is shared with the travelling drag
 * preview, which passes no `action` — the preview is `aria-hidden` and must
 * never put a second copy of a control on screen.
 */
export function ProjectHeaderBody({
  project,
  action,
}: {
  project: PresentProject;
  action?: ReactNode;
}) {
  return (
    <div data-project-header className="flex items-center gap-2 px-2 pt-1 pb-1">
      <ProjectGlyph glyph={project.glyph} accent={project.accent} />
      <span className="text-xs font-semibold text-fg-muted">{project.name}</span>
      {action}
    </div>
  );
}
