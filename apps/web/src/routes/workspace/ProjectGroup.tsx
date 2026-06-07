import { Plus } from 'lucide-react';

import { showToast } from '../../lib/toast/index.js';
import type { PresentProject } from '../../lib/workspace/types.js';
import { ProjectGlyph } from './ProjectGlyph.js';
import { WorktreeBlock } from './WorktreeBlock.js';

/**
 * One present project's slice of the rail: a quiet group header with the
 * project's accent glyph and a hover-revealed "add worktree" affordance,
 * followed by its worktrees. Missing projects are not rendered here — they live
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
  activeSurfaceByWorktreeId: Readonly<Record<number, string>>;
  onSelectSurface: (worktreeId: number, surfaceId: string) => void;
}) {
  return (
    <div className="group/group">
      <div className="flex items-center gap-2 px-2 pt-1 pb-1">
        <ProjectGlyph glyph={project.glyph} accent={project.accent} />
        <span className="text-xs font-semibold text-fg-muted">{project.name}</span>
        <button
          type="button"
          title="Add worktree"
          onClick={() => addWorktreeNotImplemented(project.name)}
          className="ml-auto grid size-5 place-items-center rounded-md text-fg-subtle opacity-0 transition group-hover/group:opacity-100 hover:bg-blue/15 hover:text-blue"
        >
          <Plus size={14} />
        </button>
      </div>

      {project.worktrees.map((worktree) => (
        <WorktreeBlock
          key={worktree.id}
          worktree={worktree}
          active={worktree.id === activeWorktreeId}
          activeSurfaceId={activeSurfaceByWorktreeId[worktree.id] ?? worktree.activeSurfaceId}
          onSelectWorktree={(worktreeId) => onSelectWorktree(project.id, worktreeId)}
          onSelectSurface={onSelectSurface}
        />
      ))}
    </div>
  );
}

// The header `+` adds a worktree to this project. The runtime can't create
// worktrees yet, so for now it just says so; wire this to the real action later.
function addWorktreeNotImplemented(projectName: string) {
  showToast({
    id: 'add-worktree-not-implemented',
    kind: 'info',
    title: "Adding a worktree isn't wired up yet.",
    subtitle: `Creating worktrees in ${projectName} lands in a later phase.`,
  });
}
