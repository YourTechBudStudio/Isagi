import { Plus } from 'lucide-react';

import type { AccentColor, Project } from '../../lib/workspace/types.js';
import { WorktreeBlock } from './WorktreeBlock.js';

const ACCENT_BG: Record<AccentColor, string> = {
  blue: 'bg-blue',
  violet: 'bg-violet',
  amber: 'bg-amber',
  green: 'bg-green',
  cyan: 'bg-cyan',
  red: 'bg-red',
};

/**
 * One project's slice of the rail: a quiet group header with a colored glyph
 * and a hover-revealed "new worktree here" affordance, followed by its worktrees.
 * Grouping is always shown, even for a single project, for a consistent model.
 */
export function ProjectGroup({
  project,
  activeWorktreeId,
  onSelectWorktree,
  onSelectSurface,
  onNewWorktree,
}: {
  project: Project;
  activeWorktreeId: string | null;
  onSelectWorktree: (worktreeId: string) => void;
  onSelectSurface: (worktreeId: string, surfaceId: string) => void;
  onNewWorktree: (projectId: string) => void;
}) {
  return (
    <div className="group/group mt-4 first:mt-0">
      <div className="flex items-center gap-2 px-2 pt-1 pb-1">
        <span
          className={`grid size-4.5 place-items-center rounded-[5px] font-mono text-[9px] font-bold text-canvas ${ACCENT_BG[project.accent]}`}
        >
          {project.glyph}
        </span>
        <span className="text-xs font-semibold text-fg-muted">{project.name}</span>
        <button
          type="button"
          title={`New worktree in ${project.name}`}
          onClick={() => onNewWorktree(project.id)}
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
          onSelectWorktree={onSelectWorktree}
          onSelectSurface={onSelectSurface}
        />
      ))}
    </div>
  );
}
