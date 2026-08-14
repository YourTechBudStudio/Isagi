import { useEffect, useMemo, useRef, useState } from 'react';

import { Overline } from '../../../src/components/Overline.js';
import { DragPreview, FixtureRail, GuideLine, type RailContextValue } from './FixtureRail.js';
import { applyMove, PROJECT_SCOPE, surfaceScope, worktreeScope, type RailModel } from './model.js';
import { SEED, SEED_ACTIVE_WORKTREE_ID } from './seed.js';
import { useRailDrag } from './useRailDrag.js';
import { DEFAULT_VARIANTS, effectivePlaceholder, HEIGHT_PX, type Variants } from './variants.js';

/**
 * The rail reorder fixture: one real-density rail, the drag engine, and a
 * control strip for the mechanics that are still undecided.
 *
 * Nothing here talks to the runtime, and the order lives in local React state.
 * The simulated persistence round trip below exists only so the *timing* of the
 * optimistic model is visible — the list commits immediately, refuses a second
 * drop while the write is in flight, and rolls back at the affected list if the
 * write is rejected. Phases 03 and 04 own the real mutation and the real copy.
 */

/**
 * A plausible local round trip. The slow setting is not a second design — it is
 * how the in-flight window becomes long enough to actually look at, and long
 * enough for a test to observe the list refusing a second drop rather than
 * racing the timer.
 */
const WRITE_LATENCY_MS = 420;
const SLOW_WRITE_LATENCY_MS = 4000;
const FAILURE_NOTICE_MS = 2200;

export function RailReorderApp() {
  const [variants, setVariants] = useState<Variants>(DEFAULT_VARIANTS);
  const [model, setModel] = useState<RailModel>(SEED);
  const [activeWorktreeId, setActiveWorktreeId] = useState(SEED_ACTIVE_WORKTREE_ID);
  const [selectedSurfaceId, setSelectedSurfaceId] = useState<number | null>(121);
  const [log, setLog] = useState<readonly string[]>([]);
  const [pendingScope, setPendingScope] = useState<string | null>(null);
  const [failedScope, setFailedScope] = useState<string | null>(null);
  const [slowWrites, setSlowWrites] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (fn: () => void, ms: number) => timers.current.push(setTimeout(fn, ms));

  const record = (entry: string) => setLog((entries) => [...entries, entry]);

  const {
    state: drag,
    sourceProps,
    pinnedProps,
  } = useRailDrag({
    scrollRef,
    isBlocked: (scope) => pendingScope === scope,
    onDrop: (scope, movedId, beforeId) => {
      const next = applyMove(model, scope, movedId, beforeId);
      if (sameOrder(model, next)) {
        record(`no-op ${scope}#${movedId}`);
        return;
      }

      // Optimistic: the list is already in its new order before anything is
      // asked to persist it.
      const previous = model;
      setModel(next);
      setPendingScope(scope);
      record(`move ${scope}#${movedId} before ${beforeId ?? 'end'}`);

      later(
        () => {
          setPendingScope(null);
          if (!variants.failNextDrop) {
            record('persisted');
            return;
          }
          // Rollback is scoped to the list that failed. Nothing else on screen
          // moves, and the notice appears at that list rather than in a toast.
          setModel(previous);
          setFailedScope(scope);
          record('rejected — order restored');
          later(() => setFailedScope(null), FAILURE_NOTICE_MS);
        },
        slowWrites ? SLOW_WRITE_LATENCY_MS : WRITE_LATENCY_MS,
      );
    },
  });

  const siblings = useMemo(() => siblingOrder(model), [model]);

  const context: RailContextValue = {
    variants,
    drag,
    sourceProps,
    pinnedProps,
    siblings,
    activeWorktreeId,
    selectedSurfaceId,
    onSelectSurface: (id) => {
      setSelectedSurfaceId(id);
      record(`select surface ${id}`);
    },
    onActivateWorktree: (id) => {
      setActiveWorktreeId(id);
      record(`activate worktree ${id}`);
    },
    onAddWorktree: (projectId) => record(`add-worktree ${projectId}`),
    pendingScope,
    failedScope,
  };

  const set = <K extends keyof Variants>(key: K, value: Variants[K]) =>
    setVariants((current) => ({ ...current, [key]: value }));

  return (
    <div className="relative z-1 flex h-screen flex-col overflow-hidden px-8 py-6 text-fg">
      <header className="mb-4 flex-none">
        <h1 className="font-display text-[19px] font-bold tracking-[-0.03em]">
          Rail drag reordering — fixture
        </h1>
        <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-fg-muted">
          Pick up any project, non-root worktree, or surface. Press and move about 5px to start
          dragging; a plain click still selects. Escape cancels. Order lives in local state only.
        </p>
      </header>

      <div className="mb-4 flex flex-none flex-wrap items-center gap-x-5 gap-y-2">
        <Axis label="preview">
          <Choice
            group="overlay"
            value="compact"
            active={variants.overlay}
            onPick={(v) => set('overlay', v)}
          >
            compact
          </Choice>
          <Choice
            group="overlay"
            value="full"
            active={variants.overlay}
            onPick={(v) => set('overlay', v)}
          >
            full group
          </Choice>
        </Axis>

        <Axis label="source" muted={variants.siblings === 'reflow'}>
          {(['hold', 'ghost', 'collapse'] as const).map((value) => (
            <Choice
              key={value}
              group="placeholder"
              value={value}
              active={effectivePlaceholder(variants)}
              disabled={variants.siblings === 'reflow'}
              onPick={(v) => set('placeholder', v)}
            >
              {value}
            </Choice>
          ))}
        </Axis>

        <Axis label="siblings">
          <Choice
            group="siblings"
            value="stable"
            active={variants.siblings}
            onPick={(v) => set('siblings', v)}
          >
            stable + guide
          </Choice>
          <Choice
            group="siblings"
            value="reflow"
            active={variants.siblings}
            onPick={(v) => set('siblings', v)}
          >
            live reflow
          </Choice>
        </Axis>

        <Axis label="guide" muted={variants.siblings === 'reflow'}>
          <Choice
            group="tone"
            value="cyan"
            active={variants.tone}
            disabled={variants.siblings === 'reflow'}
            onPick={(v) => set('tone', v)}
          >
            cyan
          </Choice>
          <Choice
            group="tone"
            value="blue"
            active={variants.tone}
            disabled={variants.siblings === 'reflow'}
            onPick={(v) => set('tone', v)}
          >
            blue
          </Choice>
        </Axis>

        <Axis label="rail">
          {(['short', 'tall', 'full'] as const).map((value) => (
            <Choice
              key={value}
              group="height"
              value={value}
              active={variants.height}
              onPick={(v) => set('height', v)}
            >
              {value}
            </Choice>
          ))}
        </Axis>

        <Axis label="persistence">
          <Toggle
            name="fail"
            on={variants.failNextDrop}
            tone="warn"
            onClick={() => set('failNextDrop', !variants.failNextDrop)}
          >
            {variants.failNextDrop ? 'drops fail' : 'drops succeed'}
          </Toggle>
          <Toggle name="slow" on={slowWrites} onClick={() => setSlowWrites((slow) => !slow)}>
            {slowWrites ? 'slow write' : 'fast write'}
          </Toggle>
          <Toggle
            name="reset"
            on={false}
            onClick={() => {
              setModel(SEED);
              setLog([]);
              setFailedScope(null);
            }}
          >
            reset
          </Toggle>
        </Axis>
      </div>

      <section className="flex min-h-0 flex-1 items-stretch gap-8">
        <FixtureRail
          model={model}
          scrollRef={scrollRef}
          height={HEIGHT_PX[variants.height]}
          context={context}
        />

        <div className="min-w-0 flex-1 overflow-y-auto">
          <Overline className="mb-2">Order</Overline>
          <pre
            data-order
            className="font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg-subtle"
          >
            {describe(model)}
          </pre>

          <Overline className="mt-6 mb-2">Events</Overline>
          <output data-log className="block font-mono text-[11.5px] leading-relaxed text-fg-subtle">
            {log.length === 0 ? '—' : log.join('\n')}
          </output>

          <p className="mt-8 font-mono text-[11px] text-fg-subtle opacity-40">
            {'// no runtime, no query cache, no persistence — just this tab'}
          </p>
        </div>
      </section>

      {drag && <GuideLine drag={drag} variants={variants} />}
      {drag && <DragPreview drag={drag} variants={variants} model={model} />}
    </div>
  );
}

/** Ordered reorderable ids per scope. The root worktree is excluded — it is pinned. */
function siblingOrder(model: RailModel): Record<string, readonly number[]> {
  const scopes: Record<string, readonly number[]> = {
    [PROJECT_SCOPE]: model.projects.map((project) => project.id),
  };
  for (const project of model.projects) {
    scopes[worktreeScope(project.id)] = project.worktrees
      .filter((worktree) => !worktree.isRoot)
      .map((worktree) => worktree.id);
    for (const worktree of project.worktrees) {
      scopes[surfaceScope(worktree.id)] = worktree.surfaces.map((surface) => surface.id);
    }
  }
  return scopes;
}

function describe(model: RailModel): string {
  return model.projects
    .map((project) => {
      const worktrees = project.worktrees
        .map((worktree) => {
          const pin = worktree.isRoot ? ' (root, pinned)' : '';
          const surfaces = worktree.surfaces.map((surface) => surface.title).join(', ');
          return `  ${worktree.title}${pin}${surfaces ? `\n    [${surfaces}]` : ''}`;
        })
        .join('\n');
      return `${project.name}\n${worktrees}`;
    })
    .join('\n\n');
}

function sameOrder(a: RailModel, b: RailModel) {
  return JSON.stringify(siblingOrder(a)) === JSON.stringify(siblingOrder(b));
}

function Axis({
  label,
  children,
  muted,
}: {
  label: string;
  children: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <div className={`flex items-center gap-1.5 ${muted ? 'opacity-45' : ''}`}>
      <span className="font-mono text-[10px] tracking-widest text-fg-subtle uppercase">
        {label}
      </span>
      {children}
    </div>
  );
}

const CONTROL_BASE =
  'rounded-md border px-2 py-1 font-mono text-[11px] transition-colors duration-micro ease-expo disabled:cursor-not-allowed';
const CONTROL_OFF = 'border-line/22 bg-white/4 text-fg-subtle hover:text-fg-muted';

function Choice<T extends string>({
  group,
  value,
  active,
  onPick,
  children,
  disabled,
}: {
  group: string;
  value: T;
  active: T;
  onPick: (value: T) => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  const selected = value === active;
  return (
    <button
      type="button"
      data-variant={`${group}:${value}`}
      aria-pressed={selected}
      disabled={disabled}
      onClick={() => onPick(value)}
      className={`${CONTROL_BASE} ${selected ? 'border-blue/40 bg-blue/14 text-fg' : CONTROL_OFF}`}
    >
      {children}
    </button>
  );
}

function Toggle({
  name,
  on,
  onClick,
  children,
  tone = 'plain',
}: {
  name: string;
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
  tone?: 'plain' | 'warn';
}) {
  return (
    <button
      type="button"
      data-control={name}
      aria-pressed={on}
      onClick={onClick}
      className={`${CONTROL_BASE} ${
        on
          ? tone === 'warn'
            ? 'border-amber/45 bg-amber/12 text-fg'
            : 'border-blue/40 bg-blue/14 text-fg'
          : CONTROL_OFF
      }`}
    >
      {children}
    </button>
  );
}
