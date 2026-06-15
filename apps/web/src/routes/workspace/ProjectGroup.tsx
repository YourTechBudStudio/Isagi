import { Plus } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';

import { surfaceTransition } from '../../lib/motion.js';
import { usePaletteStore } from '../../lib/palette/store.js';
import type { PresentProject } from '../../lib/workspace/types.js';
import { ProjectGlyph } from './ProjectGlyph.js';
import { WorktreeBlock } from './WorktreeBlock.js';

/**
 * One present project's slice of the rail: a quiet group header with the
 * project's accent glyph and a hover-revealed project-scoped Open Worktree
 * affordance, followed by its worktrees. Missing projects are not rendered here — they live
 * in the rail's Disconnected section as a single promoted row (see
 * {@link ./DisconnectedProjectRow}), so this component is present-only and the
 * Rail owns the partition.
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

  return (
    <div className="group/group">
      <div className="flex items-center gap-2 px-2 pt-1 pb-1">
        <ProjectGlyph glyph={project.glyph} accent={project.accent} />
        <span className="text-xs font-semibold text-fg-muted">{project.name}</span>
        <button
          type="button"
          title="Open worktree"
          onClick={() => openPalette('open-worktree', { projectId: String(project.id) })}
          className="ml-auto grid size-5 place-items-center rounded-md text-fg-subtle opacity-0 transition group-hover/group:opacity-100 hover:bg-blue/15 hover:text-blue"
        >
          <Plus size={14} />
        </button>
      </div>

      {/* A removed worktree collapses in place; the rows below reflow up
          naturally, and the rows above stay put. */}
      <AnimatePresence initial={false}>
        {project.worktrees.map((worktree) => (
          <motion.div
            key={worktree.id}
            exit={{ height: 0, opacity: 0 }}
            transition={surfaceTransition}
            className="overflow-hidden"
          >
            <WorktreeBlock
              projectId={project.id}
              worktree={worktree}
              active={worktree.id === activeWorktreeId}
              activeSurfaceId={activeSurfaceByWorktreeId[worktree.id] ?? worktree.activeSurfaceId}
              onSelectWorktree={(worktreeId) => onSelectWorktree(project.id, worktreeId)}
              onSelectSurface={onSelectSurface}
            />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
