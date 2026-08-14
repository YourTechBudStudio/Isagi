import { Plus } from 'lucide-react';
import { createContext, useContext, type CSSProperties } from 'react';

import { AttentionDot } from '../../../src/components/AttentionDot.js';
import { Overline } from '../../../src/components/Overline.js';
import { paneSessionIcon } from '../../../src/lib/workspace/surface-presentation.js';
import { ProjectGlyph } from '../../../src/routes/workspace/ProjectGlyph.js';
import {
  DISCONNECTED_SCOPE,
  PROJECT_SCOPE,
  surfaceScope,
  worktreeScope,
  type FixtureProject,
  type FixtureSurface,
  type FixtureWorktree,
  type RailModel,
} from './model.js';
import type { DragRef, DragState } from './useRailDrag.js';
import { effectivePlaceholder, type Variants } from './variants.js';

/**
 * The rail's hierarchy, rebuilt inside the fixture.
 *
 * This is a deliberate, temporary fork of `src/routes/workspace/Rail.tsx`,
 * `ProjectGroup.tsx` and `WorktreeBlock.tsx`, and Phase 05 repays it by applying
 * the chosen treatment to those files and deleting whatever the fixture no
 * longer needs. The fork exists because drag behaviour has to live *inside* the
 * rows, and this phase is not allowed to touch the production rail. Importing
 * the real components would also pull in the command dispatcher, the palette
 * store, the pending-delete store and `ContextMenu` — providers with nothing to
 * say about how a drag feels.
 *
 * What is *not* forked is anything that decides how a row reads at a glance:
 * `ProjectGlyph`, `AttentionDot`, `Overline` and the surface icon mapping are
 * the production components, so the guide colour and the preview's weight are
 * judged against real accents and real attention states rather than lookalikes.
 */

export interface RailContextValue {
  readonly variants: Variants;
  readonly drag: DragState | null;
  readonly sourceProps: (ref: DragRef) => Record<string, unknown>;
  readonly pinnedProps: () => Record<string, unknown>;
  /** Ordered sibling ids per scope, so a row can work out its own reflow shift. */
  readonly siblings: Readonly<Record<string, readonly number[]>>;
  readonly activeWorktreeId: number;
  readonly selectedSurfaceId: number | null;
  readonly onSelectSurface: (id: number) => void;
  readonly onActivateWorktree: (id: number) => void;
  readonly onAddWorktree: (projectId: number) => void;
  /** The list whose move is in flight, or the list whose move just failed. */
  readonly pendingScope: string | null;
  readonly failedScope: string | null;
}

const RailContext = createContext<RailContextValue | null>(null);
const useRail = () => useContext(RailContext)!;

export function FixtureRail({
  model,
  scrollRef,
  height,
  context,
}: {
  model: RailModel;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  height: number | null;
  context: RailContextValue;
}) {
  return (
    <RailContext.Provider value={context}>
      <aside
        data-fixture-rail
        data-pending={context.pendingScope ?? ''}
        className="flex min-h-0 w-59 flex-none flex-col rounded-md border border-line/20 bg-linear-to-b from-elevated/55 to-canvas/30 backdrop-blur-md"
        style={{ height: height ?? '100%' }}
      >
        <div className="px-4 pt-4 pb-2.5">
          <span className="font-display text-base font-bold tracking-[-0.04em]">
            isa<span className="text-blue">gi</span>
          </span>
        </div>

        <div
          ref={scrollRef}
          data-rail-scroll
          className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2.5 pb-2.5"
        >
          <div className="flex-1">
            <Overline className="mx-2 mt-2 mb-1">Active</Overline>
            {/* The projects scope spans the nested worktrees too, which is what
                makes "drop a project anywhere over the project list" legal while
                a worktree hovering those same pixels stays illegal. */}
            <div data-drag-scope={PROJECT_SCOPE}>
              {model.projects.map((project) => (
                <ProjectGroupBlock key={project.id} project={project} />
              ))}
            </div>
          </div>

          {model.missing.length > 0 && (
            <div data-drag-scope={DISCONNECTED_SCOPE}>
              <Overline className="mx-2 mt-5 mb-1 text-error/70">Disconnected</Overline>
              {model.missing.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  data-row={`missing-${project.id}`}
                  className="flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-left transition duration-micro ease-expo hover:bg-error/8"
                >
                  <ProjectGlyph glyph={project.glyph} disconnected />
                  <span className="truncate text-[13px] font-medium text-fg-muted">
                    {project.name}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="px-3 pb-3">
          <p className="font-mono text-[10px] text-fg-subtle opacity-40">
            {'// fixture rail — no runtime behind it'}
          </p>
        </div>
      </aside>
    </RailContext.Provider>
  );
}

function ProjectGroupBlock({ project }: { project: FixtureProject }) {
  const rail = useRail();
  const dragRef: DragRef = { scope: PROJECT_SCOPE, id: project.id };
  const root = project.worktrees.filter((worktree) => worktree.isRoot);
  const rest = project.worktrees.filter((worktree) => !worktree.isRoot);

  return (
    <div
      {...rail.sourceProps(dragRef)}
      data-row={`project-${project.id}`}
      className={`group/group mt-4 cursor-grab first:mt-0 ${sourceClass(rail, dragRef)} ${failureClass(rail, PROJECT_SCOPE)}`}
    >
      <Reflow rail={rail} dragRef={dragRef}>
        <ProjectHeader project={project} onAdd={() => rail.onAddWorktree(project.id)} />
        <div data-drag-scope={worktreeScope(project.id)}>
          {/* The root worktree registers no source, so it contributes no
              insertion boundary and nothing can land above it. */}
          {root.map((worktree) => (
            <WorktreeRow key={worktree.id} projectId={project.id} worktree={worktree} pinned />
          ))}
          {rest.map((worktree) => (
            <WorktreeRow key={worktree.id} projectId={project.id} worktree={worktree} />
          ))}
        </div>
      </Reflow>
    </div>
  );
}

function ProjectHeader({ project, onAdd }: { project: FixtureProject; onAdd: () => void }) {
  return (
    <div data-project-header className="flex items-center gap-2 px-2 pt-1 pb-1">
      <ProjectGlyph glyph={project.glyph} accent={project.accent} />
      <span className="text-xs font-semibold text-fg-muted">{project.name}</span>
      {/* Nested controls keep their own press semantics; the engine refuses to
          start a gesture from anything inside `data-no-drag`. */}
      <button
        type="button"
        data-no-drag
        data-add-worktree={project.id}
        title="Open worktree"
        onClick={onAdd}
        className="ml-auto grid size-5 place-items-center rounded-md text-fg-subtle opacity-0 transition group-hover/group:opacity-100 hover:bg-blue/15 hover:text-blue"
      >
        <Plus size={14} />
      </button>
    </div>
  );
}

function WorktreeRow({
  projectId,
  worktree,
  pinned,
}: {
  projectId: number;
  worktree: FixtureWorktree;
  pinned?: boolean;
}) {
  const rail = useRail();
  const scope = worktreeScope(projectId);
  const dragRef: DragRef = { scope, id: worktree.id };
  const active = worktree.id === rail.activeWorktreeId;

  return (
    <div
      {...(pinned ? rail.pinnedProps() : rail.sourceProps(dragRef))}
      data-row={`worktree-${worktree.id}`}
      data-pinned={pinned ? '' : undefined}
      className={`${worktree.parked ? 'opacity-55 hover:opacity-80' : ''} ${
        // The root reads as immovable before it is touched: an ordinary cursor
        // among grab cursors. Trying anyway gets the refusal cursor, nothing more.
        pinned
          ? 'cursor-default'
          : `cursor-grab ${sourceClass(rail, dragRef)} ${failureClass(rail, scope)}`
      }`}
    >
      <Reflow rail={rail} dragRef={pinned ? null : dragRef}>
        {/* Selection lives on the title row, not the wrapper: the wrapper also
            contains the surface list, and a click on a surface must not double
            as a click on its worktree. */}
        <div onClick={() => rail.onActivateWorktree(worktree.id)}>
          <WorktreeButton worktree={worktree} active={active} />
        </div>
        {active && <SurfaceList worktree={worktree} />}
      </Reflow>
    </div>
  );
}

function WorktreeButton({
  worktree,
  active,
  flat,
}: {
  worktree: FixtureWorktree;
  active: boolean;
  flat?: boolean;
}) {
  return (
    <div
      className={`flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-left transition duration-micro ease-expo ${flat ? '' : 'hover:bg-line/14'}`}
    >
      <AttentionDot state={worktree.attention} />
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-[13px] ${active ? 'font-semibold text-fg' : 'font-medium text-fg-muted'}`}
        >
          {worktree.title}
        </span>
        <span className="mt-0.5 block truncate font-mono text-[10.5px] text-fg-subtle">
          {worktree.path} · {worktree.branch}
        </span>
      </span>
    </div>
  );
}

function SurfaceList({ worktree }: { worktree: FixtureWorktree }) {
  return (
    <div className="my-1 ml-5 flex flex-col gap-0.5 border-l-2 border-blue/50 pl-2.75">
      <div data-drag-scope={surfaceScope(worktree.id)}>
        {worktree.surfaces.map((surface) => (
          <SurfaceRowView key={surface.id} worktreeId={worktree.id} surface={surface} />
        ))}
      </div>
      {worktree.surfaces.length === 0 && (
        <p className="py-1 pl-1 font-mono text-[10.5px] text-fg-subtle opacity-60">
          {'// no surfaces yet'}
        </p>
      )}
    </div>
  );
}

function SurfaceRowView({ worktreeId, surface }: { worktreeId: number; surface: FixtureSurface }) {
  const rail = useRail();
  const scope = surfaceScope(worktreeId);
  const dragRef: DragRef = { scope, id: surface.id };

  return (
    <div
      {...rail.sourceProps(dragRef)}
      data-row={`surface-${surface.id}`}
      onClick={() => rail.onSelectSurface(surface.id)}
      className={`cursor-grab ${sourceClass(rail, dragRef)} ${failureClass(rail, scope)}`}
    >
      <Reflow rail={rail} dragRef={dragRef}>
        <SurfaceBody surface={surface} selected={rail.selectedSurfaceId === surface.id} />
      </Reflow>
    </div>
  );
}

function SurfaceBody({ surface, selected }: { surface: FixtureSurface; selected: boolean }) {
  const Icon = paneSessionIcon(surface.paneKind);
  return (
    <div
      className={`relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors duration-micro ease-expo ${
        selected ? 'bg-white/8 text-fg' : 'text-fg-muted hover:bg-white/5 hover:text-fg'
      }`}
    >
      <AttentionDot state={surface.attention} />
      <Icon size={14} className={selected ? 'text-fg' : 'text-fg-subtle'} />
      <span className="truncate">{surface.title}</span>
    </div>
  );
}

/**
 * What the source leaves behind.
 *
 * `collapse` zeroes the outer box rather than using `hidden`, because the
 * engine measures the *child* to learn how tall the carried item is — and
 * `display: none` would zero that too, leaving reflow with no gap to open. The
 * margin is zeroed alongside the height so the list closes up completely.
 *
 * The collapse is instant rather than animated: an in-flight height transition
 * would keep moving the very boundaries the user is trying to aim at.
 */
function sourceClass(rail: RailContextValue, ref: DragRef) {
  if (!isDragged(rail, ref)) return '';
  return {
    hold: 'rounded-sm opacity-45 outline-1 outline-dashed outline-line/45',
    ghost: 'opacity-[0.07]',
    collapse: 'mt-0! h-0 overflow-hidden',
  }[effectivePlaceholder(rail.variants)];
}

/**
 * Live sibling reflow, the comparison case against the stationary guide. The
 * source is collapsed out of flow in this mode, so translating everything at or
 * after the slot down by the source's height opens exactly one gap.
 *
 * The transform deliberately lands on an inner wrapper rather than on the row
 * the engine registered. `getBoundingClientRect` reports transformed geometry,
 * so translating the measured element would feed the shift straight back into
 * the slot search — the list would pick a slot, move, re-measure, and pick a
 * different one. Keeping the measured box still breaks that loop: layout
 * decides where the boundaries are, and the transform is presentation only.
 */
function Reflow({
  rail,
  dragRef,
  children,
}: {
  rail: RailContextValue;
  dragRef: DragRef | null;
  children: React.ReactNode;
}) {
  return <div style={dragRef ? reflowStyle(rail, dragRef) : undefined}>{children}</div>;
}

function reflowStyle(rail: RailContextValue, ref: DragRef): CSSProperties | undefined {
  const drag = rail.drag;
  if (rail.variants.siblings !== 'reflow' || !drag?.target) return undefined;
  if (drag.ref.scope !== ref.scope || drag.ref.id === ref.id) return undefined;

  const rest = (rail.siblings[ref.scope] ?? []).filter((id) => id !== drag.ref.id);
  const slot = drag.target.beforeId === null ? rest.length : rest.indexOf(drag.target.beforeId);
  const position = rest.indexOf(ref.id);
  if (slot < 0 || position < 0) return undefined;

  return {
    transform: position >= slot ? `translateY(${drag.size.height}px)` : undefined,
    transition: 'transform var(--duration-ui) var(--ease-expo)',
  };
}

/** A rejected move tints its list for one beat, at the list, not in a toast. */
function failureClass(rail: RailContextValue, scope: string) {
  // Amber, not red: a rejected reorder is a recoverable refusal, not destruction.
  if (rail.failedScope === scope) return 'rounded-sm outline-1 outline-amber/50';
  if (rail.pendingScope === scope) return 'opacity-80';
  return '';
}

function isDragged(rail: RailContextValue, ref: DragRef) {
  return rail.drag?.ref.scope === ref.scope && rail.drag.ref.id === ref.id;
}

export function GuideLine({ drag, variants }: { drag: DragState; variants: Variants }) {
  if (!drag.target || variants.siblings === 'reflow') return null;
  return (
    <div
      data-guide
      data-guide-tone={variants.tone}
      aria-hidden
      className="pointer-events-none fixed z-50"
      style={{ left: drag.target.left + 4, width: drag.target.width - 8, top: drag.target.y - 1 }}
    >
      <div className={`h-0.5 rounded-full ${variants.tone === 'cyan' ? 'bg-cyan' : 'bg-blue'}`} />
    </div>
  );
}

/**
 * The travelling preview. It is deliberately not the row itself: the row keeps
 * its own semantics in the list, and this is a flat, quieter copy of it that
 * cannot be clicked. Invalid ground dims it rather than reddening it.
 */
export function DragPreview({
  drag,
  variants,
  model,
}: {
  drag: DragState;
  variants: Variants;
  model: RailModel;
}) {
  const content = previewContent(drag, variants, model);
  if (!content) return null;
  return (
    <div
      data-overlay
      data-overlay-ref={`${drag.ref.scope}#${drag.ref.id}`}
      data-overlay-variant={variants.overlay}
      data-overlay-valid={drag.target ? 'true' : 'false'}
      aria-hidden
      className="pointer-events-none fixed z-60 overflow-hidden rounded-sm border border-line/25 bg-elevated/85 shadow-[0_16px_48px_rgba(0,0,0,0.4)] backdrop-blur-md"
      style={{
        left: drag.pointer.x - drag.grab.dx,
        // A tall group grabbed near its foot would otherwise hang far above the
        // pointer; clamping the vertical grab keeps the preview under the hand.
        top: drag.pointer.y - Math.min(drag.grab.dy, 40),
        width: drag.size.width || undefined,
        opacity: drag.target ? 1 : 0.55,
      }}
    >
      {content}
    </div>
  );
}

function previewContent(drag: DragState, variants: Variants, model: RailModel) {
  const full = variants.overlay === 'full';

  if (drag.ref.scope === PROJECT_SCOPE) {
    const project = model.projects.find((candidate) => candidate.id === drag.ref.id);
    if (!project) return null;
    return (
      <div className="group/group">
        <ProjectHeader project={project} onAdd={() => {}} />
        {full &&
          project.worktrees.map((worktree) => (
            <div key={worktree.id} className={worktree.parked ? 'opacity-55' : ''}>
              <WorktreeButton worktree={worktree} active={false} flat />
            </div>
          ))}
      </div>
    );
  }

  for (const project of model.projects) {
    if (drag.ref.scope === worktreeScope(project.id)) {
      const worktree = project.worktrees.find((candidate) => candidate.id === drag.ref.id);
      if (!worktree) return null;
      return (
        <div className={worktree.parked ? 'opacity-55' : ''}>
          <WorktreeButton worktree={worktree} active={false} flat />
          {full && worktree.surfaces.length > 0 && (
            <div className="my-1 ml-5 flex flex-col gap-0.5 border-l-2 border-blue/50 pl-2.75">
              {worktree.surfaces.map((surface) => (
                <SurfaceBody key={surface.id} surface={surface} selected={false} />
              ))}
            </div>
          )}
        </div>
      );
    }
    for (const worktree of project.worktrees) {
      if (drag.ref.scope === surfaceScope(worktree.id)) {
        const surface = worktree.surfaces.find((candidate) => candidate.id === drag.ref.id);
        return surface ? <SurfaceBody surface={surface} selected={false} /> : null;
      }
    }
  }
  return null;
}
