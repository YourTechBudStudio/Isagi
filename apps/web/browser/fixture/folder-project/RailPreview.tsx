import { Plus } from 'lucide-react';

import { AttentionDot } from '../../../src/components/AttentionDot.js';
import { Overline } from '../../../src/components/Overline.js';
import { compactHomePath } from '../../../src/lib/workspace/selectors.js';
import type { MissingProject, PresentProject, Worktree } from '../../../src/lib/workspace/types.js';
import { DisconnectedProjectRow } from '../../../src/routes/workspace/DisconnectedProjectRow.js';
import { ProjectGlyph } from '../../../src/routes/workspace/ProjectGlyph.js';
import { useVariants } from './variants.js';

/**
 * A prototype of the rail, carrying the settled presentation treatment.
 *
 * **This is declared prototype debt, repaid in phase 07.** It is not the
 * production `Rail`, and it deliberately leaves out the drag engine, the
 * context menus, the update footer, and the order-refusal notices. Those are
 * unaffected by the folder treatment and re-implementing them here would fork
 * workspace orchestration to answer a question about two lines of text.
 *
 * What it does keep is the production row *language* — the same glyph, the same
 * attention dot, the same type sizes, densities and colours — because the
 * treatment was chosen by looking at it, and it could not have been judged in
 * different chrome.
 *
 * Structure preserved from the real rail, because the mock must not accidentally
 * claim these were lost: the Active/Disconnected partition, the root
 * environment sitting first and unmovable in its project, and removal reaching a
 * project through the canvas rather than through the row.
 */
export function RailPreview({
  presentProjects,
  missingProjects,
  activeWorktreeId,
  selectedProjectId,
  onSelectWorktree,
  onSelectMissingProject,
}: {
  readonly presentProjects: readonly PresentProject[];
  readonly missingProjects: readonly MissingProject[];
  readonly activeWorktreeId: number | null;
  readonly selectedProjectId: number | null;
  readonly onSelectWorktree: (projectId: number, worktreeId: number) => void;
  readonly onSelectMissingProject: (projectId: number) => void;
}) {
  return (
    <aside className="flex min-h-0 flex-col border-r border-line/20 bg-linear-to-b from-elevated/55 to-canvas/30 backdrop-blur-md">
      <div className="px-4 pt-4 pb-2.5">
        <span className="font-display text-base font-bold tracking-[-0.04em]">
          isa<span className="text-blue">gi</span>
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2.5 pt-1 pb-2.5">
        <Overline className="mx-2 mt-2 mb-1">Active</Overline>
        {presentProjects.map((project, index) => (
          <div key={project.id} className={index === 0 ? '' : 'pt-4'}>
            <ProjectHeader project={project} />
            {project.worktrees.map((worktree) => (
              <WorktreeRow
                key={worktree.id}
                worktree={worktree}
                active={worktree.id === activeWorktreeId}
                onSelect={() => onSelectWorktree(project.id, worktree.id)}
              />
            ))}
          </div>
        ))}

        {missingProjects.length > 0 && (
          <div className="mt-6">
            <Overline className="mx-2 mt-2 mb-1">Disconnected</Overline>
            {missingProjects.map((project) => (
              <DisconnectedProjectRow
                key={project.id}
                project={project}
                active={project.id === selectedProjectId && activeWorktreeId === null}
                onSelect={() => onSelectMissingProject(project.id)}
              />
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

/**
 * The project header. The Open worktree affordance is the availability claim:
 * a folder project has one environment and the runtime refuses to make another,
 * so offering the `+` would be an invitation to a refusal.
 */
function ProjectHeader({ project }: { project: PresentProject }) {
  const showCurrent = useVariants((state) => state.showCurrent);
  const offersWorktrees = showCurrent || project.kind === 'git';

  return (
    <div
      data-project-header={project.id}
      className="group/group flex items-center gap-2 px-2 pt-1 pb-1"
    >
      <ProjectGlyph glyph={project.glyph} accent={project.accent} />
      <span className="text-xs font-semibold text-fg-muted">{project.name}</span>
      {offersWorktrees && (
        <button
          type="button"
          title="Open worktree"
          data-open-worktree={project.id}
          className="ml-auto grid size-5 place-items-center rounded-md text-fg-subtle opacity-0 transition group-hover/group:opacity-100 focus-visible:opacity-100 hover:bg-blue/15 hover:text-blue"
        >
          <Plus size={14} />
        </button>
      )}
    </div>
  );
}

function WorktreeRow({
  worktree,
  active,
  onSelect,
}: {
  readonly worktree: Worktree;
  readonly active: boolean;
  readonly onSelect: () => void;
}) {
  const showCurrent = useVariants((state) => state.showCurrent);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      data-worktree-row={worktree.id}
      className="block w-full rounded-sm text-left transition duration-micro ease-expo hover:bg-line/14 focus-visible:bg-line/14 focus-visible:outline-none"
    >
      <div className="flex w-full items-center gap-2.5 px-2.5 py-2">
        <AttentionDot state={worktree.attention} />
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate text-[13px] ${active ? 'font-semibold text-fg' : 'font-medium text-fg-muted'}`}
          >
            {worktree.title}
          </span>
          <span
            data-worktree-subtitle={worktree.id}
            className="mt-0.5 block truncate font-mono text-[10.5px] text-fg-subtle"
          >
            <Subtitle worktree={worktree} showCurrent={showCurrent} />
          </span>
        </span>
      </div>
    </button>
  );
}

/**
 * The subtitle: the environment's path, and nothing else.
 *
 * The Git ref is gone from here, for both kinds, because it was never carrying
 * its own weight. `worktreeTitle` in the runtime returns `worktree.branch`
 * whenever there is one, so a branched worktree printed its branch twice — once
 * as the row's title and again after the path. A folder environment has no ref
 * at all, so `gitRef` would have fallen through to the literal word `detached`,
 * which is not merely unhelpful but false: nothing is detached, because nothing
 * was ever attached.
 *
 * What the ref is not is *lost*. The status strip still names the active
 * environment's branch or short head, which is the one place a ref is genuinely
 * load-bearing rather than repeated. The narrow cost is a branchless Git
 * worktree that is not currently active: it titles itself from its basename, so
 * its commit is not on screen until it is selected.
 */
function Subtitle({
  worktree,
  showCurrent,
}: {
  readonly worktree: Worktree;
  readonly showCurrent: boolean;
}) {
  const path = compactHomePath(worktree.path);
  return <>{showCurrent ? `${path} · ${gitRef(worktree)}` : path}</>;
}

function gitRef(worktree: Worktree) {
  return worktree.branch ?? shortHead(worktree.head) ?? 'detached';
}

function shortHead(head: string | null | undefined) {
  return head ? head.slice(0, 7) : null;
}
