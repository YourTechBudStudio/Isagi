import { QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import type { WorkflowEventDto } from '@isagi/contracts';

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
 * Nothing between the components and `fetch` is stubbed: the inspector reads through the real
 * queries and the real live sync, lays out through the real ELK worker and renders the real
 * components.
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
  // from the connection's snapshot, and it can only hear it once the live sync has subscribed.
  useEffect(() => {
    if (runtimeIdentity === null) return;
    publishWorkflowSignal({ type: 'connected' });
    publishWorkflowSignal({ type: 'snapshot', summaries: [runtime.world().summary] });
  }, [runtime, runtimeIdentity]);

  /**
   * Replaces the run on the surface, the way a relaunch would: the old run's summary arrives with its
   * surface released, and the new run arrives attached. The new run has its own id, so nothing cached
   * about the old one can leak into it.
   */
  const replaceRun = (change: () => void) => {
    const previous = runtime.world().summary;
    change();
    publishWorkflowSignal({ type: 'run_changed', summary: { ...previous, surfaceId: null } });
    publishWorkflowSignal({ type: 'run_changed', summary: runtime.world().summary });
  };

  /** A runtime event, pushed as the runtime pushes one: the event, then the run's new summary. */
  const push = (event: WorkflowEventDto) => {
    publishWorkflowSignal({ type: 'run_event', event });
    publishWorkflowSignal({ type: 'run_changed', summary: runtime.world().summary });
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
              replaceRun(() => {
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
          data-action="reload-build"
          className="rounded border border-line/40 px-1.5 py-0.5 font-mono text-fg-subtle"
          // A Retry reloading the next build: one `code_reloaded` event and a new summary, with the
          // inspector open or not. Nothing about the executions changes.
          onClick={() => push(runtime.reloadNextBuild())}
        >
          Retry · reload build
        </button>
        <button
          type="button"
          data-action="long-history"
          className="rounded border border-line/40 px-1.5 py-0.5 font-mono text-fg-subtle"
          onClick={() => replaceRun(() => runtime.setLongHistory(true))}
        >
          Long history
        </button>
        <button
          type="button"
          data-action="fail-execution"
          className="rounded border border-line/40 px-1.5 py-0.5 font-mono text-fg-subtle"
          onClick={() => runtime.failNextExecutionRead()}
        >
          Fail next execution read
        </button>
        <button
          type="button"
          data-action="fail-events"
          className="rounded border border-line/40 px-1.5 py-0.5 font-mono text-fg-subtle"
          onClick={() => runtime.failNextEventsRead()}
        >
          Fail next event read
        </button>
        <button
          type="button"
          data-action="arrive-reply"
          className="rounded border border-line/40 px-1.5 py-0.5 font-mono text-fg-subtle"
          // The agent's turn ended and its reply was recorded on the operation. The runtime appends
          // an event naming the execution, and the client refetches that execution.
          onClick={() => push(runtime.arriveReply())}
        >
          Arrive reply
        </button>
        <button
          type="button"
          data-action="duplicate-event"
          className="rounded border border-line/40 px-1.5 py-0.5 font-mono text-fg-subtle"
          onClick={() => {
            // An event the client already holds, delivered again. It is appended once.
            const last = runtime.world().events.at(-1);
            if (last) publishWorkflowSignal({ type: 'run_event', event: last });
          }}
        >
          Duplicate event
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
