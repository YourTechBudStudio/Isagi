import { Plus } from 'lucide-react';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';

import { Button } from '../../components/Button.js';
import { Overline } from '../../components/Overline.js';
import { surfaceTransition } from '../../lib/motion.js';
import { usePaletteStore } from '../../lib/palette/store.js';
import { modKey } from '../../lib/platform.js';
import { useWorkspace } from '../../lib/workspace/hooks.js';
import type { MissingProject, PresentProject } from '../../lib/workspace/types.js';
import { DisconnectedProjectRow } from './DisconnectedProjectRow.js';
import { ProjectGroup } from './ProjectGroup.js';
import { RailUpdateFooter } from './RailUpdateFooter.js';
import { useDesktopUpdate } from './useDesktopUpdate.js';

/**
 * The Rail — Isagi's navigation spine. Brand at the top, the add-project
 * affordance, then projects split into two sections: `Active` (present projects,
 * each an expandable worktree group) and `Disconnected` (projects the runtime
 * can't reach right now), pinned at the foot of the list. The update footer sits
 * at the very bottom — the installed version and whatever the desktop update has
 * to say (see {@link ./RailUpdateFooter}). The host shell may provide a larger
 * top inset; the whole top is the drag region in desktop builds.
 *
 * The two sections share one `LayoutGroup`, and each project carries a stable
 * `layoutId`. Because a project is mounted in exactly one section at a time, a
 * project that flips status *travels* between the sections as a single element
 * rather than disappearing from one place and reappearing in another. Each row
 * uses `layout="position"` (not full `layout`): it animates only its *position*
 * — closing the gap a departing project leaves, or making room for an arriving
 * one — and never its *size*. Animating size here would scale the whole project
 * subtree whenever anything inside it (a worktree, a surface) is added or
 * removed, dragging unrelated rows around. Internal size changes instead reflow
 * naturally, and the removed item plays its own local collapse (see
 * {@link ./ProjectGroup} and {@link ./WorktreeBlock}).
 */
export function Rail() {
  const {
    projects,
    activeWorktreeId,
    selectedProjectId,
    selectWorktree,
    selectMissingProject,
    selectSurface,
    activeSurfaceByWorktreeId,
  } = useWorkspace();
  const openPalette = usePaletteStore((state) => state.openPalette);

  const presentProjects = projects.filter(
    (project): project is PresentProject => project.status === 'present',
  );
  const missingProjects = projects.filter(
    (project): project is MissingProject => project.status === 'missing',
  );

  return (
    <aside className="flex min-h-0 flex-col border-r border-line/20 bg-linear-to-b from-elevated/55 to-canvas/30 backdrop-blur-md">
      <div className="px-4 pt-(--isagi-rail-top-inset,1rem) pb-2.5 [-webkit-app-region:drag]">
        <span className="font-display text-base font-bold tracking-[-0.04em]">
          isa<span className="text-blue">gi</span>
        </span>
      </div>

      <AddProjectButton onOpen={() => openPalette('add-project')} />

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2.5 pt-1 pb-2.5">
        <LayoutGroup>
          <div className="flex-1">
            <Overline className="mx-2 mt-2 mb-1">Active</Overline>
            {presentProjects.map((project) => (
              <motion.div
                key={project.id}
                layout="position"
                layoutId={`project-${project.id}`}
                transition={surfaceTransition}
                className="mt-4 first:mt-0"
              >
                <ProjectGroup
                  project={project}
                  activeWorktreeId={activeWorktreeId}
                  onSelectWorktree={selectWorktree}
                  activeSurfaceByWorktreeId={activeSurfaceByWorktreeId}
                  onSelectSurface={selectSurface}
                />
              </motion.div>
            ))}
          </div>

          {/* The section header fades on its own; the rows travel via layoutId. */}
          <AnimatePresence initial={false}>
            {missingProjects.length > 0 && (
              <motion.div
                key="disconnected-header"
                layout
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={surfaceTransition}
              >
                <Overline className="mx-2 mt-5 mb-1 text-error/70">Disconnected</Overline>
              </motion.div>
            )}
          </AnimatePresence>

          {missingProjects.map((project) => (
            <motion.div
              key={project.id}
              layout="position"
              layoutId={`project-${project.id}`}
              transition={surfaceTransition}
            >
              <DisconnectedProjectRow
                project={project}
                active={project.id === selectedProjectId}
                onSelect={() => selectMissingProject(project.id)}
              />
            </motion.div>
          ))}
        </LayoutGroup>
      </div>

      <UpdateFooter />
    </aside>
  );
}

/**
 * The footer, or the space it will occupy. A desktop host that has not yet
 * answered still gets its geometry reserved: the whole point of this treatment
 * is that the rail never moves, and a footer that appears one IPC round trip
 * after mount would shove the project list up on the way in. A hosted web build
 * has no host and reserves nothing.
 */
export function UpdateFooter() {
  const update = useDesktopUpdate();
  if (update.presence === 'unsupported') return null;
  if (update.presence === 'unresolved') {
    // The same metrics as the populated footer, and nothing invented to fill
    // them: no version, no token, no skeleton.
    return (
      <div data-update-footer data-update-state="unresolved" aria-hidden>
        <div className="h-9" />
        <div className="h-0.5 w-full" />
      </div>
    );
  }
  return <RailUpdateFooter {...update} />;
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
