import { Plus } from 'lucide-react';

import { usePaletteStore } from '../../lib/palette/store.js';
import { modKey } from '../../lib/platform.js';
import { useWorkspace } from '../../lib/workspace/store.js';
import { ProjectGroup } from './ProjectGroup.js';

const APP_VERSION = '0.0.1';

/**
 * The Rail — Isagi's navigation spine. Brand at the top, the new-worktree
 * affordance, then worktrees grouped by project. The active worktree expands in
 * place to reveal its surfaces (nested rail). A version whisper sits at the
 * foot. The host shell may provide a larger top inset; the whole top is the
 * drag region in desktop builds.
 */
export function Rail() {
  const { projects, activeWorktreeId, selectWorktree, selectSurface } = useWorkspace();
  const openPalette = usePaletteStore((state) => state.openPalette);
  const hasWorktrees = projects.some((project) => project.worktrees.length > 0);

  return (
    <aside className="flex min-h-0 flex-col border-r border-line/20 bg-linear-to-b from-elevated/55 to-canvas/30 backdrop-blur-md">
      <div className="px-4 pt-(--isagi-rail-top-inset,1rem) pb-2.5 [-webkit-app-region:drag]">
        <span className="font-display text-base font-bold tracking-[-0.04em]">
          isa<span className="text-blue">gi</span>
        </span>
      </div>

      <NewWorktreeButton onOpen={() => openPalette('new-worktree')} />

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pt-1 pb-2.5">
        {hasWorktrees ? (
          <>
            <p className="mx-2 mt-2 mb-1 font-mono text-[10px] tracking-widest text-fg-subtle uppercase">
              Active
            </p>
            {projects.map((project) => (
              <ProjectGroup
                key={project.id}
                project={project}
                activeWorktreeId={activeWorktreeId}
                onSelectWorktree={selectWorktree}
                onSelectSurface={selectSurface}
                onNewWorktree={(projectId) => openPalette('new-worktree', { project: projectId })}
              />
            ))}
          </>
        ) : (
          <RailEmptyState />
        )}
      </div>

      <div className="px-4 pt-2.5 pb-3.5">
        <span className="font-mono text-[11px] text-fg-subtle opacity-50">v{APP_VERSION}</span>
      </div>
    </aside>
  );
}

function NewWorktreeButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="mx-3 mt-1 mb-1.5 flex items-center gap-2.5 rounded-sm border border-blue/30 bg-blue/14 px-3 py-2.25 text-[12.5px] font-medium text-fg transition duration-micro ease-expo hover:-translate-y-px hover:bg-blue/22"
    >
      <Plus size={15} className="text-blue" />
      <span>New worktree</span>
      <span className="ml-auto rounded-md border border-line/35 px-1.5 py-px font-mono text-[10.5px] text-fg-subtle">
        {modKey}N
      </span>
    </button>
  );
}

function RailEmptyState() {
  return (
    <div className="flex flex-col gap-3 px-3 pt-8">
      <p className="text-[13.5px] leading-relaxed text-fg-muted">
        No worktrees yet. Your agents are well-rested and slightly suspicious of the quiet.
      </p>
      <p className="font-mono text-[11px] text-fg-subtle opacity-60">{`// ${modKey}N — put them to work`}</p>
    </div>
  );
}
