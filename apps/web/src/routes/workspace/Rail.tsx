import { Plus } from 'lucide-react';

import { Button } from '../../components/Button.js';
import { Overline } from '../../components/Overline.js';
import { usePaletteStore } from '../../lib/palette/store.js';
import { modKey } from '../../lib/platform.js';
import { useWorkspace } from '../../lib/workspace/store.js';
import { ProjectGroup } from './ProjectGroup.js';

const APP_VERSION = '0.0.1';

/**
 * The Rail — Isagi's navigation spine. Brand at the top, the add-project
 * affordance, then worktrees grouped by project. The active worktree expands in
 * place to reveal its surfaces (nested rail). A version whisper sits at the
 * foot. The host shell may provide a larger top inset; the whole top is the
 * drag region in desktop builds.
 */
export function Rail() {
  const {
    projects,
    activeWorktreeId,
    selectedProjectId,
    selectWorktree,
    selectMissingProject,
    selectSurface,
  } = useWorkspace();
  const openPalette = usePaletteStore((state) => state.openPalette);

  return (
    <aside className="flex min-h-0 flex-col border-r border-line/20 bg-linear-to-b from-elevated/55 to-canvas/30 backdrop-blur-md">
      <div className="px-4 pt-(--isagi-rail-top-inset,1rem) pb-2.5 [-webkit-app-region:drag]">
        <span className="font-display text-base font-bold tracking-[-0.04em]">
          isa<span className="text-blue">gi</span>
        </span>
      </div>

      <AddProjectButton onOpen={() => openPalette('add-project')} />

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pt-1 pb-2.5">
        <Overline className="mx-2 mt-2 mb-1">Active</Overline>
        {projects.map((project) => (
          <ProjectGroup
            key={project.id}
            project={project}
            activeWorktreeId={activeWorktreeId}
            selectedProjectId={selectedProjectId}
            onSelectWorktree={selectWorktree}
            onSelectMissingProject={selectMissingProject}
            onSelectSurface={selectSurface}
            onAddProject={() => openPalette('add-project')}
          />
        ))}
      </div>

      <div className="px-4 pt-2.5 pb-3.5">
        <span className="font-mono text-[11px] text-fg-subtle opacity-50">v{APP_VERSION}</span>
      </div>
    </aside>
  );
}

function AddProjectButton({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="px-3 pt-1 pb-1.5">
      <Button
        size="sm"
        fullWidth
        icon={Plus}
        shortcut={`${modKey}N`}
        onClick={onOpen}
        className="hover:-translate-y-px"
      >
        Add project
      </Button>
    </div>
  );
}
