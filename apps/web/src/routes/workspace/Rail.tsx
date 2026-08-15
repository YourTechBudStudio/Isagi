import { Plus } from 'lucide-react';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';

import { Button } from '../../components/Button.js';
import { Overline } from '../../components/Overline.js';
import { surfaceTransition } from '../../lib/motion.js';
import { usePaletteStore } from '../../lib/palette/store.js';
import { modKey } from '../../lib/platform.js';
import { useWorkspace } from '../../lib/workspace/hooks.js';
import { scopeKey, type RailOrderScope } from '../../lib/workspace/rail-order.js';
import type { MissingProject, PresentProject } from '../../lib/workspace/types.js';
import { DisconnectedProjectRow } from './DisconnectedProjectRow.js';
import { ProjectGroup, ProjectHeaderBody } from './ProjectGroup.js';
import { useRailDragLayer } from './rail-drag-context.js';
import { RailDragProvider } from './RailDrag.js';
import { RailOrderNotice } from './RailOrderNotice.js';
import { RailUpdateFooter } from './RailUpdateFooter.js';
import { useDesktopUpdate } from './useDesktopUpdate.js';

/** Present projects are the only ordered project list; Disconnected is not one. */
const projectsScope: RailOrderScope = { kind: 'projects' };

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
 *
 * Present projects are also the rail's outermost reorder scope, and the scope
 * container stops short of the Disconnected section — so a project dragged over
 * a disconnected row simply never finds its own scope under the pointer, and the
 * Disconnected section needs no rule of its own to stay unordered. While any
 * rail drag is in flight, `layout` is switched off on every project wrapper:
 * picking a row up collapses it, and letting Motion animate that collapse would
 * put a second author on the same movement the drag is already describing.
 */
export function Rail() {
  return (
    <RailDragProvider>
      <RailBody />
    </RailDragProvider>
  );
}

function RailBody() {
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
  const rail = useRailDragLayer();
  // One switch for every project wrapper, including the disconnected ones: a
  // nested worktree or surface collapse changes a project's height too, so
  // suppressing only the projects scope would still leave Motion animating a
  // movement the drag already owns.
  //
  // `layout={false}` alone is not enough, and neither is a zero-duration
  // transition: a `layoutId` makes the element a projection node that Motion
  // keeps measuring regardless, so when the reordered list lands Motion animates
  // the row from where it sat *before* the drop — the move played a second time,
  // slowly, over a rail that was already correct. The identity has to go too for
  // the duration of the hold. Nothing is lost: `layoutId` is here for a project
  // travelling between Active and Disconnected, which is a status change, not
  // something a drag can cause.
  const projectLayout = rail.dragging ? false : ('position' as const);
  const projectIdentity = (projectId: number) =>
    rail.dragging ? {} : { layoutId: `project-${projectId}` };

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

      <div
        ref={rail.scrollRef}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2.5 pt-1 pb-2.5"
      >
        <LayoutGroup>
          <div className="flex-1" data-drag-scope={scopeKey(projectsScope)}>
            <Overline className="mx-2 mt-2 mb-1">Active</Overline>
            {presentProjects.map((project, index) => (
              // Three nested elements, deliberately: the outer one hosts the
              // refusal notice outside the measured source, the source itself
              // owns the spacing, and only the innermost carries the drag's
              // transform.
              //
              // The separation is `pt-4`, not `mt-4`, because the drag measures
              // this element's box to size the gap it opens. Padding is inside
              // that box; a margin would not be, and every project gap would
              // come out 16px short. `first:` cannot be used either — a refusal
              // notice can precede this element inside the wrapper, which would
              // shift the whole list by re-spacing the top project.
              <div key={project.id}>
                <RailOrderNotice scope={projectsScope} id={project.id} />
                <div
                  {...rail.sourceProps(projectsScope, project.id, () => (
                    <ProjectHeaderBody project={project} />
                  ))}
                  className={`cursor-grab ${index === 0 ? '' : 'pt-4'} ${rail.draggedClass(projectsScope, project.id)}`}
                >
                  <motion.div
                    layout={projectLayout}
                    {...projectIdentity(project.id)}
                    transition={surfaceTransition}
                  >
                    <div style={rail.reflowStyle(projectsScope, project.id)}>
                      <ProjectGroup
                        project={project}
                        activeWorktreeId={activeWorktreeId}
                        onSelectWorktree={selectWorktree}
                        activeSurfaceByWorktreeId={activeSurfaceByWorktreeId}
                        onSelectSurface={selectSurface}
                      />
                    </div>
                  </motion.div>
                </div>
              </div>
            ))}
          </div>

          {/* The section header fades on its own; the rows travel via layoutId. */}
          <AnimatePresence initial={false}>
            {missingProjects.length > 0 && (
              <motion.div
                key="disconnected-header"
                layout={!rail.dragging}
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
              layout={projectLayout}
              {...projectIdentity(project.id)}
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
