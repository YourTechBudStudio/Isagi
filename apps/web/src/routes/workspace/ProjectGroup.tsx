import { Plus } from 'lucide-react';

import { AttentionDot } from '../../components/AttentionDot.js';
import { compactHomePath } from '../../lib/workspace/selectors.js';
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
 * One project's slice of the rail: a quiet group header with a local UI glyph
 * and followed by its worktrees. Missing projects stay selectable as a single
 * config-error row so the user can see what needs fixing.
 */
export function ProjectGroup({
  project,
  activeWorktreeId,
  selectedProjectId,
  onSelectWorktree,
  onSelectMissingProject,
  onSelectSurface,
  onAddProject,
}: {
  project: Project;
  activeWorktreeId: number | null;
  selectedProjectId: number | null;
  onSelectWorktree: (worktreeId: number) => void;
  onSelectMissingProject: (projectId: number) => void;
  onSelectSurface: (worktreeId: number, surfaceId: string) => void;
  onAddProject: () => void;
}) {
  const missing = project.status === 'missing';

  return (
    <div className="group/group mt-4 first:mt-0">
      <div className="flex items-center gap-2 px-2 pt-1 pb-1">
        <span
          className={
            missing
              ? 'grid size-4.5 place-items-center rounded-[5px] border border-dashed border-error/55 font-mono text-[9px] font-bold text-error'
              : `grid size-4.5 place-items-center rounded-[5px] font-mono text-[9px] font-bold text-canvas ${ACCENT_BG[project.accent]}`
          }
        >
          {project.glyph}
        </span>
        <span className={`text-xs font-semibold ${missing ? 'text-fg-subtle' : 'text-fg-muted'}`}>
          {project.name}
        </span>
        {!missing && (
          <button
            type="button"
            title="Add another project"
            onClick={onAddProject}
            className="ml-auto grid size-5 place-items-center rounded-md text-fg-subtle opacity-0 transition group-hover/group:opacity-100 hover:bg-blue/15 hover:text-blue"
          >
            <Plus size={14} />
          </button>
        )}
      </div>

      {missing ? (
        <MissingProjectRow
          project={project}
          active={project.id === selectedProjectId}
          onSelect={() => onSelectMissingProject(project.id)}
        />
      ) : (
        project.worktrees.map((worktree) => (
          <WorktreeBlock
            key={worktree.id}
            worktree={worktree}
            active={worktree.id === activeWorktreeId}
            onSelectWorktree={onSelectWorktree}
            onSelectSurface={onSelectSurface}
          />
        ))
      )}
    </div>
  );
}

function MissingProjectRow({
  project,
  active,
  onSelect,
}: {
  project: Project;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <>
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? 'true' : undefined}
        className={`flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-left transition duration-micro ease-expo hover:bg-error/8 ${
          active ? 'bg-error/10' : ''
        }`}
      >
        <AttentionDot state="error" />
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate text-[13px] ${active ? 'font-semibold text-fg' : 'font-medium text-fg-muted'}`}
          >
            {project.name}
          </span>
          <span className="mt-0.5 block truncate font-mono text-[10.5px] text-fg-subtle">
            {project.missingReason ??
              (project.rootPath
                ? `${compactHomePath(project.rootPath)} · unavailable`
                : 'unavailable')}
          </span>
        </span>
        <span className="rounded-full border border-error/35 bg-error/8 px-1.75 py-0.5 font-mono text-[9.5px] font-medium text-error">
          config error
        </span>
      </button>
      <p className="my-1 ml-5 border-l-2 border-error/40 py-1.5 pl-3.5 font-mono text-[10.5px] text-fg-subtle opacity-70">
        {'// project is unavailable — nothing to show here'}
      </p>
    </>
  );
}
