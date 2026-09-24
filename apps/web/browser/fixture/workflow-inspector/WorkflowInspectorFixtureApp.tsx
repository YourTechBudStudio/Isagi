import { QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { queryClient } from '../../../src/lib/query/client.js';
import { useWorkspaceStore } from '../../../src/lib/workspace/store.js';
import {
  useRuntimeIdentity,
  useWorkflowRuntimeSync,
} from '../../../src/lib/workspace/workflow/queries.js';
import { publishWorkflowSignal } from '../../../src/lib/workspace/workflow/signals.js';
import { WorkflowBarContainer } from '../../../src/routes/workspace/WorkflowBarContainer.js';
import { FIXTURE_PLACEMENT, type InspectorRuntimeControls } from './fake-runtime.js';
import type { ScriptedEngineControls } from './scripted-engine.js';
import { scenarioKeys, type ScenarioKey } from './world.js';

/**
 * The **production** bar and inspector over a fake runtime boundary.
 *
 * Nothing between the components and `fetch` is stubbed: the inspector mounts the real coordinator,
 * reads through the real queries, lays out through the real ELK worker and renders the real components.
 * A props-driven page would have produced the same pixels while testing none of it.
 *
 * The strip is scaffolding. It publishes the runtime signals a real runtime would send and swaps
 * what the fake runtime answers with; it is never part of the product.
 */
export function WorkflowInspectorFixtureApp({
  runtime,
  engine,
}: {
  readonly runtime: InspectorRuntimeControls;
  readonly engine: ScriptedEngineControls;
}) {
  useEffect(() => {
    const store = useWorkspaceStore.getState();
    store.setActiveSurface(FIXTURE_PLACEMENT.worktreeId, FIXTURE_PLACEMENT.surfaceId);
    store.selectWorktree(FIXTURE_PLACEMENT.projectId, FIXTURE_PLACEMENT.worktreeId);
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <FixtureShell runtime={runtime} engine={engine} />
    </QueryClientProvider>
  );
}

function FixtureShell({
  runtime,
  engine,
}: {
  readonly runtime: InspectorRuntimeControls;
  readonly engine: ScriptedEngineControls;
}) {
  useWorkflowRuntimeSync();
  const runtimeIdentity = useRuntimeIdentity();
  const [scenario, setScenario] = useState<ScenarioKey>('waiting_questions');

  // Published rather than written into the cache: a real client learns which run occupies a surface
  // from the connection's snapshot, and the ordering rule — identity first, then subscribe, then
  // publish — is part of what this page exercises.
  useEffect(() => {
    if (runtimeIdentity === null) return;
    publishWorkflowSignal({ type: 'connected' });
    publishWorkflowSignal({ type: 'snapshot', summaries: [runtime.world().summary] });
  }, [runtime, runtimeIdentity]);

  /**
   * Swaps what the runtime answers with, and tells the client the way a runtime would.
   *
   * A scenario switch is not a transition — it replaces the run's whole history behind the client's
   * back, which nothing real ever does. So it is delivered as the run leaving the surface and a new
   * one arriving: the bar drops it, the inspector unmounts with it, and the next opening hydrates
   * from scratch. Publishing only `run_changed` left a live coordinator holding the previous
   * scenario's executions under the new scenario's heading — a lie the page would have told about
   * itself.
   */
  const apply = (change: () => void) => {
    change();
    const summary = runtime.world().summary;
    publishWorkflowSignal({
      type: 'run_detached',
      runId: summary.runId,
      surfaceId: FIXTURE_PLACEMENT.surfaceId,
    });
    publishWorkflowSignal({ type: 'snapshot', summaries: [summary] });
  };

  return (
    <main className="flex h-screen flex-col bg-canvas text-fg" data-workflow-inspector-fixture>
      <div className="flex flex-none flex-wrap items-center gap-1.5 p-2 text-[11px]">
        {scenarioKeys.map((key) => (
          <button
            key={key}
            type="button"
            data-action={`scenario-${key}`}
            aria-pressed={scenario === key}
            className={`rounded border border-line/40 px-1.5 py-0.5 font-mono ${
              scenario === key ? 'bg-blue text-scrim' : 'text-fg-subtle'
            }`}
            onClick={() =>
              apply(() => {
                setScenario(key);
                runtime.setScenario(key);
              })
            }
          >
            {key}
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-line/30" />
        <button
          type="button"
          data-action="adopt-pin"
          className="rounded border border-line/40 px-1.5 py-0.5 font-mono text-fg-subtle"
          onClick={() => apply(() => runtime.adoptSecondPin())}
        >
          Retry · adopt pin
        </button>
        <button
          type="button"
          data-action="adopt-pin-live"
          className="rounded border border-line/40 px-1.5 py-0.5 font-mono text-fg-subtle"
          onClick={() => {
            // A Retry adopting a pin the way the runtime actually delivers one: a committed
            // transition, no execution rows, and the inspector still mounted. An empty upsert keeps
            // the execution map's identity, which is precisely the shape that used to reach the
            // aggregation cache looking like a clock tick.
            runtime.adoptSecondPin();
            const world = runtime.world();
            const revision = world.summary.revision + 1;
            publishWorkflowSignal({
              type: 'transition',
              delta: {
                runId: world.summary.runId,
                revision,
                transition: {
                  revision,
                  recordedAt: new Date().toISOString(),
                  kind: 'retry_pin_adopted',
                  frameId: 1,
                  executionId: null,
                  attemptId: null,
                  operationKey: null,
                  waitId: null,
                  artifactHash: world.artifactHash,
                  detailRef: null,
                  stateRef: null,
                },
                changes: {
                  executions: [],
                  frames: [],
                  operations: [],
                  summary: { ...world.summary, revision },
                },
              },
            });
          }}
        >
          Retry · adopt pin live
        </button>
        <button
          type="button"
          data-action="long-history"
          className="rounded border border-line/40 px-1.5 py-0.5 font-mono text-fg-subtle"
          onClick={() => apply(() => runtime.setLongHistory(true))}
        >
          Long history
        </button>
        <button
          type="button"
          data-action="many-operations"
          className="rounded border border-line/40 px-1.5 py-0.5 font-mono text-fg-subtle"
          onClick={() => apply(() => runtime.setManyOperations(true))}
        >
          Many operations
        </button>
        <button
          type="button"
          data-action="fail-operations"
          className="rounded border border-line/40 px-1.5 py-0.5 font-mono text-fg-subtle"
          onClick={() => runtime.failNextOperationsRead()}
        >
          Fail next operations read
        </button>
        <button
          type="button"
          data-action="settle-operation"
          className="rounded border border-line/40 px-1.5 py-0.5 font-mono text-fg-subtle"
          onClick={() => {
            // A settlement delivered while somebody is looking at the card, exactly as the runtime
            // publishes it: one committed transition carrying the row it changed.
            const world = runtime.world();
            const operation = world.operations.find((row) => row.state === 'uncertain');
            if (!operation) return;
            publishWorkflowSignal({
              type: 'transition',
              delta: {
                runId: world.summary.runId,
                revision: world.summary.revision + 1,
                transition: {
                  revision: world.summary.revision + 1,
                  recordedAt: new Date().toISOString(),
                  kind: 'operation_settled',
                  frameId: operation.frameId,
                  executionId: operation.executionId,
                  attemptId: operation.attemptId,
                  operationKey: operation.operationKey,
                  waitId: null,
                  artifactHash: null,
                  detailRef: null,
                  stateRef: null,
                },
                changes: {
                  executions: [],
                  frames: [],
                  // `uncertaintyDetail` is present exactly while the state is `uncertain`, so a
                  // settlement that established delivery clears it along with the state.
                  operations: [
                    {
                      ...operation,
                      state: 'completed',
                      uncertaintyDetail: null,
                      receiptRef: { inline: { turnId: 't-settled' } },
                      settledAt: new Date().toISOString(),
                    },
                  ],
                },
              },
            });
          }}
        >
          Settle operation
        </button>
        <button
          type="button"
          data-action="duplicate-delta"
          className="rounded border border-line/40 px-1.5 py-0.5 font-mono text-fg-subtle"
          onClick={() => {
            // A revision already applied. The client drops it rather than applying it twice.
            const world = runtime.world();
            publishWorkflowSignal({
              type: 'transition',
              delta: {
                runId: world.summary.runId,
                revision: 1,
                transition: {
                  revision: 1,
                  recordedAt: new Date().toISOString(),
                  kind: 'log',
                  frameId: 1,
                  executionId: null,
                  attemptId: null,
                  operationKey: null,
                  waitId: null,
                  artifactHash: null,
                  detailRef: null,
                  stateRef: null,
                },
                changes: { executions: [], frames: [], operations: [] },
              },
            });
          }}
        >
          Duplicate delta
        </button>
        <button
          type="button"
          data-action="skip-revision"
          className="rounded border border-line/40 px-1.5 py-0.5 font-mono text-fg-subtle"
          onClick={() => {
            // A revision the client never saw. It cannot apply a delta that is not exactly one past
            // its coverage, so this forces a real REST gap fill before anything later lands.
            const world = runtime.world();
            publishWorkflowSignal({
              type: 'transition',
              delta: {
                runId: world.summary.runId,
                revision: world.summary.revision + 5,
                transition: {
                  revision: world.summary.revision + 5,
                  recordedAt: new Date().toISOString(),
                  kind: 'log',
                  frameId: 1,
                  executionId: null,
                  attemptId: null,
                  operationKey: null,
                  waitId: null,
                  artifactHash: null,
                  detailRef: null,
                  stateRef: null,
                },
                changes: { executions: [], frames: [], operations: [] },
              },
            });
          }}
        >
          Skip a revision
        </button>
        <button
          type="button"
          data-action="hold-layout"
          className="rounded border border-line/40 px-1.5 py-0.5 font-mono text-fg-subtle"
          onClick={() => engine.holdAnswers()}
        >
          Hold layout
        </button>
        <button
          type="button"
          data-action="release-layout-newest-first"
          className="rounded border border-line/40 px-1.5 py-0.5 font-mono text-fg-subtle"
          onClick={() => engine.releaseNewestFirst()}
        >
          Release layout newest first
        </button>
        <button
          type="button"
          data-action="fail-engine"
          className="rounded border border-line/40 px-1.5 py-0.5 font-mono text-fg-subtle"
          onClick={() => engine.failNextEngine()}
        >
          Fail next engine
        </button>
        <button
          type="button"
          data-action="fail-layout"
          className="rounded border border-line/40 px-1.5 py-0.5 font-mono text-fg-subtle"
          onClick={() => engine.failNextLayout()}
        >
          Fail next layout
        </button>
        <button
          type="button"
          data-action="reconnect"
          className="rounded border border-line/40 px-1.5 py-0.5 font-mono text-fg-subtle"
          onClick={() => {
            publishWorkflowSignal({ type: 'disconnected' });
            publishWorkflowSignal({ type: 'connected' });
          }}
        >
          Reconnect
        </button>
      </div>

      {/* The work surface the inspector sits above, and the bar it opens from. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 p-3">
          <div className="h-full rounded-md border border-line/28 bg-terminal-surface/80 p-4 font-mono text-[12.5px] text-fg-muted">
            <p className="text-green">$ isagi run release-check</p>
            <p className="text-fg-subtle">the work surface this inspector sits above</p>
          </div>
        </div>
        <WorkflowBarContainer inspectorEngineFactory={engine.factory} />
      </div>
    </main>
  );
}
