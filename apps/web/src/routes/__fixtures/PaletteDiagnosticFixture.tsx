import { motion } from 'motion/react';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';

import { Chip } from '../../components/Chip.js';
import { paletteCopy } from '../../copy/index.js';
import { useKeyboardSelection } from '../../hooks/useKeyboardSelection.js';
import { surfaceTransition } from '../../lib/motion.js';
import { runPaletteEffects } from '../../lib/palette/effects.js';
import { assembleEntries } from '../../lib/palette/entries.js';
import { initialPaletteState, isBusy, paletteReducer } from '../../lib/palette/machine.js';
import type {
  PaletteContext,
  PaletteEntry,
  WorkflowFailurePresentation,
} from '../../lib/palette/types.js';
import {
  EntryList,
  OutcomePanel,
  RunningPanel,
  Tip,
  outcomeActions,
} from '../workspace/CommandPaletteViews.js';

/**
 * TEMPORARY dev-only fixture for Phase 03 (workflow-source-precedence).
 *
 * It exists solely to human-review the command palette's workflow failure
 * interactions — broken winning packages and whole-list discovery failures —
 * with static data, before Phase 04 wires the real query error. It reuses the
 * production `paletteReducer`, `runPaletteEffects`, `EntryList`, `OutcomePanel`,
 * and keyboard-selection behaviour so the review reflects real interaction, but
 * feeds fixture-local context and a no-op `pushRecent` so it never touches the
 * runtime, React Query, or the production recency store.
 *
 * REMOVE IN PHASE 04: delete this file, the `__fixtures` folder, and the
 * DEV-gated `/__fixtures/palette` route in `App.tsx`. See
 * `scratch/plans/workflow-source-precedence/decisions.md`.
 */

const activeSurfaceWorkflowSummary: NonNullable<PaletteContext['activeSurfaceWorkflowSummary']> = {
  runId: 99,
  rootRunId: 99,
  parentRunId: null,
  workflowKey: 'current',
  title: 'Current workflow',
  status: 'running',
  paused: false,
  waitKind: null,
  blockingWait: null,
  worktreeId: 11,
  surfaceId: 42,
};

// Fixture-local context modelled on a single active worktree with a couple of
// unrelated commands, so "unrelated groups survive a workflow failure" is real.
function scenarioContext(overrides: Partial<PaletteContext>): PaletteContext {
  return {
    projects: [],
    activeProject: {
      id: 1,
      name: 'isagi',
      rootPath: '/repo/isagi',
      glyph: 'IS',
      accent: 'blue',
      status: 'present',
      worktrees: [],
    },
    activeWorktree: {
      id: 11,
      projectId: 1,
      title: 'feat/configurable-workflows',
      path: '/repo/isagi-feature',
      branch: 'feat/configurable-workflows',
      head: 'abcdef0',
      isRoot: false,
      attention: 'idle',
      parked: false,
      surfaces: [{ id: 42, title: 'Main', paneKinds: [], attention: 'idle' }],
      activeSurfaceId: 42,
    },
    activeSurface: { id: 42, title: 'Main', paneKinds: [], attention: 'idle' },
    activePaneId: null,
    launchableHarnesses: [],
    ...overrides,
  };
}

const discoveryFailure: WorkflowFailurePresentation = {
  label: paletteCopy.workflows.failure.discovery.label,
  sub: paletteCopy.workflows.failure.discovery.sub,
  content: {
    title: paletteCopy.workflows.failure.discovery.title,
    body: paletteCopy.workflows.failure.discovery.body,
    diagnostic: {
      label: paletteCopy.workflows.failure.diagnosticLabel,
      detail: '/Users/dev/workflow-roots/extra · request req_9f2a10 · workflow_discovery_failed',
    },
  },
};

const genericFailure: WorkflowFailurePresentation = {
  label: paletteCopy.workflows.failure.generic.label,
  sub: paletteCopy.workflows.failure.generic.sub,
  content: {
    title: paletteCopy.workflows.failure.generic.title,
    // A generic query failure must not invent a scan cause: web-owned fallback
    // body, and no source path in the diagnostic. Phase 04 maps this row by kind
    // (transport/decode -> runtimeErrorCopy; unexpected -> generic.body).
    body: paletteCopy.workflows.failure.generic.body,
    diagnostic: {
      label: paletteCopy.workflows.failure.diagnosticLabel,
      detail: 'workflow_rejected · request req_5c8d21',
    },
  },
};

interface Scenario {
  readonly id: string;
  readonly label: string;
  readonly ctx: PaletteContext;
}

const SCENARIOS: readonly Scenario[] = [
  {
    id: 'healthy',
    label: 'Healthy',
    ctx: scenarioContext({
      workflowDescriptors: [
        {
          ok: true,
          workflowKey: 'release',
          manifest: { title: 'Release', description: 'Runs the release checklist.' },
        },
        {
          ok: true,
          workflowKey: 'deploy',
          manifest: { title: 'Deploy', description: 'Ship the current branch to staging.' },
        },
      ],
    }),
  },
  {
    id: 'occupied',
    label: 'Occupied',
    ctx: scenarioContext({
      workflowDescriptors: [
        {
          ok: true,
          workflowKey: 'release',
          manifest: { title: 'Release', description: 'Runs the release checklist.' },
        },
      ],
      activeSurfaceWorkflowSummary,
    }),
  },
  {
    id: 'broken',
    label: 'Broken package',
    ctx: scenarioContext({
      workflowDescriptors: [
        {
          ok: false,
          workflowKey: 'release',
          reason: 'stale_source',
          diagnostic:
            'winner: /Users/dev/workflow-roots/extra/release\nshadowed: /Users/dev/.isagi/workflows/release',
        },
      ],
    }),
  },
  {
    id: 'mixed',
    label: 'Mixed',
    ctx: scenarioContext({
      workflowDescriptors: [
        {
          ok: true,
          workflowKey: 'release',
          manifest: { title: 'Release', description: 'Runs the release checklist.' },
        },
        {
          ok: false,
          workflowKey: 'db-migrate',
          reason: 'unsupported_contract',
          diagnostic: 'winner: /Users/dev/workflow-roots/extra/db-migrate',
        },
        {
          ok: true,
          workflowKey: 'deploy',
          manifest: { title: 'Deploy', description: 'Ship the current branch to staging.' },
        },
      ],
    }),
  },
  {
    id: 'discovery',
    label: 'Scan failure',
    ctx: scenarioContext({ workflowFailure: discoveryFailure }),
  },
  {
    id: 'generic',
    label: 'Generic failure',
    ctx: scenarioContext({ workflowFailure: genericFailure }),
  },
  {
    id: 'overflow',
    label: 'Long path',
    ctx: scenarioContext({
      workflowDescriptors: [
        {
          ok: false,
          workflowKey: 'org.acme.super-long-workflow-key-that-should-truncate-in-the-row-label',
          reason: 'artifact_tampered',
          diagnostic:
            'winner: /Users/dev/some/really/deep/nested/workflow-collection-root/that-keeps-going/org.acme.super-long-workflow-key/package\n' +
            'shadowed: /Users/dev/.isagi/workflows/org.acme.super-long-workflow-key/package\n' +
            'shadowed: /opt/isagi/system-workflows/org.acme.super-long-workflow-key/package\n' +
            'verifier receipt hash mismatch across 3 candidate roots',
        },
      ],
    }),
  },
];

export function PaletteDiagnosticFixture() {
  const [scenarioId, setScenarioId] = useState<string>(SCENARIOS[0]?.id ?? 'healthy');
  const scenario = SCENARIOS.find((candidate) => candidate.id === scenarioId) ?? SCENARIOS[0]!;
  const ctx = scenario.ctx;
  const allEntries = useMemo(() => assembleEntries(ctx), [ctx]);

  const [machine, send] = useReducer(paletteReducer, initialPaletteState);
  const panelRef = useRef<HTMLDivElement>(null);
  const selectedIndexRef = useRef<number | null>(null);
  const seenEffectIds = useRef(new Set<number>());
  const pathSuggestTimer = useRef<number | null>(null);

  // Open on route load and whenever the scenario changes (dropping any open
  // outcome). Nothing else reopens, so Esc/back and Close from an outcome land on
  // the observable closed state — matching production, where they close the palette.
  useEffect(() => {
    send({ type: 'opened' });
  }, [scenarioId]);

  // Real effect runner, real entry.run() — only a run effect fires for diagnostic
  // rows, so no runtime call is reachable. `pushRecent` is a no-op by design.
  useEffect(() => {
    runPaletteEffects(machine.effects, {
      allEntries,
      ctx,
      send,
      pushRecent: () => {},
      pathSuggestTimer,
      seenEffectIds,
    });
  }, [machine.effects, allEntries, ctx]);

  const running = isBusy(machine);
  const view =
    machine.kind === 'closed'
      ? ({ kind: 'closed' } as const)
      : running
        ? ({ kind: 'running' } as const)
        : machine.kind === 'error'
          ? ({ kind: 'error', content: machine.content } as const)
          : machine.kind === 'result'
            ? ({ kind: 'result', content: machine.content } as const)
            : ({ kind: 'list', items: allEntries } as const);

  const selectableLength =
    view.kind === 'list'
      ? view.items.length
      : view.kind === 'error' || view.kind === 'result'
        ? outcomeActions(view.content).length
        : 0;
  const viewKey = `${scenarioId}:${view.kind}:${selectableLength}`;
  const defaultIndex = view.kind === 'running' || view.kind === 'closed' ? null : 0;

  useEffect(() => {
    panelRef.current?.focus();
  }, [viewKey]);

  // The fixture only drives error-detail rows through the real reducer path.
  // Healthy, occupied, and command rows are shown for visual context but are
  // inert here (launching them needs the runtime the fixture deliberately lacks).
  const runEntry = (entry: PaletteEntry) => {
    if (entry.tone !== 'error') {
      return;
    }
    send({ type: 'activate-entry', entry, ctx });
  };

  const activate = () => {
    const index = selectedIndexRef.current;
    if (view.kind === 'list') {
      const entry = index === null ? undefined : view.items[index];
      if (entry) {
        runEntry(entry);
      }
    } else if (view.kind === 'error' || view.kind === 'result') {
      const action = outcomeActions(view.content)[index ?? 0];
      if (action) {
        send({ type: 'outcome-action', value: action.value });
      }
    }
  };

  const selection = useKeyboardSelection({
    length: selectableLength,
    snapKey: viewKey,
    defaultIndex,
    capabilities: { back: !running },
    handlers: { onAccept: activate, onBack: () => send({ type: 'back', ctx }) },
  });
  selectedIndexRef.current = selection.selectedIndex;
  const sel = selection.selectedIndex;

  return (
    <div className="relative min-h-screen bg-canvas text-fg">
      <div className="fixed top-4 left-4 z-60 flex max-w-88 flex-col gap-2 rounded-lg border border-line/25 bg-elevated/80 p-3 backdrop-blur-xl">
        <p className="font-mono text-[10.5px] text-fg-subtle">
          palette diagnostics · phase 03 dev fixture
        </p>
        <div className="flex flex-wrap gap-1.5">
          {SCENARIOS.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              onClick={() => setScenarioId(candidate.id)}
              className={`rounded-sm px-2.5 py-1 text-[12px] transition duration-micro ease-expo ${
                candidate.id === scenarioId
                  ? 'bg-white/12 text-fg'
                  : 'bg-white/5 text-fg-muted hover:bg-white/8'
              }`}
            >
              {candidate.label}
            </button>
          ))}
        </div>
        <p className="font-mono text-[10.5px] text-fg-subtle">↑↓ move · ↵ select · esc closes</p>
      </div>

      {view.kind === 'closed' ? (
        // Production closes the palette on Esc/back and on Close from an outcome.
        // The fixture shows that honestly (no auto-reopen) and offers an explicit,
        // fixture-only way back in.
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 px-4">
          <p className="font-mono text-[12px] text-fg-subtle">Palette closed.</p>
          <button
            type="button"
            autoFocus
            onClick={() => send({ type: 'opened' })}
            className="rounded-md border border-line/30 bg-elevated/80 px-4 py-2 text-[13px] text-fg transition duration-micro ease-expo hover:bg-white/8"
          >
            Reopen palette
          </button>
        </div>
      ) : (
        <div className="fixed inset-0 z-50 flex justify-center bg-scrim/45 px-4 pt-[14vh] backdrop-blur-sm">
          <motion.div
            ref={panelRef}
            tabIndex={-1}
            initial={{ opacity: 0, y: 6, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={surfaceTransition}
            onKeyDown={selection.onKeyDown}
            className="h-fit w-145 max-w-full overflow-hidden rounded-lg border border-line/30 bg-elevated/85 shadow-lift outline-none backdrop-blur-2xl"
          >
            <div className="flex flex-wrap items-center gap-1.5 border-b border-line/16 px-4 py-3.5">
              <Chip tone="command">Workflows</Chip>
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg-subtle">
                {scenario.label.toLowerCase()} · fixture
              </span>
            </div>

            {running && <div aria-hidden className="palette-progress" />}

            <div className="max-h-[46vh] overflow-y-auto p-1.5">
              {view.kind === 'running' ? (
                <RunningPanel content={{ title: paletteCopy.running.title }} />
              ) : view.kind === 'error' ? (
                <OutcomePanel
                  content={view.content}
                  kind="error"
                  sel={sel}
                  onAction={(value) => send({ type: 'outcome-action', value })}
                />
              ) : view.kind === 'result' ? (
                <OutcomePanel
                  content={view.content}
                  kind="result"
                  sel={sel}
                  onAction={(value) => send({ type: 'outcome-action', value })}
                />
              ) : (
                <EntryList
                  items={view.items}
                  sel={sel}
                  onPick={(index) => {
                    const entry = view.items[index];
                    if (entry) {
                      runEntry(entry);
                    }
                  }}
                />
              )}
            </div>

            <Tip mode={view.kind === 'error' || view.kind === 'result' ? 'outcome' : 'list'} />
          </motion.div>
        </div>
      )}
    </div>
  );
}
