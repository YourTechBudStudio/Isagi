import { Effect } from 'effect';
import { useEffect, useRef, useState } from 'react';

import type { WorkflowEventDto } from '@isagi/contracts';

import { AppStateProvider } from '../../../src/lib/state/AppStateProvider.js';
import { useRegistry } from '../../../src/lib/state/registry.js';
import { runApp } from '../../../src/lib/state/runtime.js';
import {
  restoreActivePaneFocus,
  usePaneFocusTarget,
} from '../../../src/lib/workspace/activation.js';
import {
  selectWorktree,
  setActivePane,
  setActiveSurface,
} from '../../../src/lib/workspace/store.js';
import type { WorkflowSignal } from '../../../src/lib/workspace/workflow/live.js';
import { useRuntimeIdentity } from '../../../src/lib/workspace/workflow/queries.js';
import { receiveWorkflowSignal } from '../../../src/lib/workspace/workflow/sync.js';
import { WorkflowBarContainer } from '../../../src/routes/workspace/WorkflowBarContainer.js';
import { createFixtureRegistry } from '../test-support/registry.js';
import { FIXTURE_PLACEMENT, type InspectorRuntimeControls } from './fake-runtime.js';
import type { ScriptedEngineControls } from './scripted-engine.js';
import { scenarioKeys, type ScenarioKey } from './world.js';

const fixtureRegistry = createFixtureRegistry();

/**
 * Deliver runtime signals the way the runtime-events connection does: in order, through the
 * production live sync of this page's app session.
 */
function publishWorkflowSignals(...signals: readonly WorkflowSignal[]) {
  void runApp(
    fixtureRegistry,
    Effect.forEach(signals, (signal) => receiveWorkflowSignal(signal), { discard: true }),
  );
}

declare global {
  interface Window {
    inspectorWorkbench?: {
      /**
       * Ask the production focus router to put keyboard focus on the active pane, as a terminal does
       * when it re-asserts focus (its activation after the bar's resize reaches it, or a re-render).
       */
      readonly reassertPaneFocus: () => void;
    };
  }
}

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
    setActiveSurface(fixtureRegistry, FIXTURE_PLACEMENT.worktreeId, FIXTURE_PLACEMENT.surfaceId);
    selectWorktree(fixtureRegistry, FIXTURE_PLACEMENT.projectId, FIXTURE_PLACEMENT.worktreeId);
    window.inspectorWorkbench = {
      reassertPaneFocus: () => restoreActivePaneFocus(fixtureRegistry),
    };
  }, []);

  return (
    <AppStateProvider registry={fixtureRegistry}>
      <FixtureShell runtime={runtime} engine={engine} />
    </AppStateProvider>
  );
}

function FixtureShell({
  runtime,
  engine,
}: {
  readonly runtime: InspectorRuntimeControls;
  readonly engine: ScriptedEngineControls;
}) {
  const runtimeIdentity = useRuntimeIdentity();
  const [scenario, setScenario] = useState<ScenarioKey>('waiting_questions');
  const [terminalMounted, setTerminalMounted] = useState(false);

  // Published rather than written into the cache: a real client learns which run occupies a surface
  // from the connection's snapshot. Sent once the runtime answers, as a connection would.
  useEffect(() => {
    if (runtimeIdentity === null) return;
    publishWorkflowSignals(
      { type: 'connected' },
      { type: 'snapshot', summaries: [runtime.world().summary] },
    );
  }, [runtime, runtimeIdentity]);

  /**
   * Replaces the run on the surface, the way a relaunch would: the old run's summary arrives with its
   * surface released, and the new run arrives attached. The new run has its own id, so nothing cached
   * about the old one can leak into it.
   */
  const replaceRun = (change: () => void) => {
    const previous = runtime.world().summary;
    change();
    publishWorkflowSignals(
      { type: 'run_changed', summary: { ...previous, surfaceId: null } },
      { type: 'run_changed', summary: runtime.world().summary },
    );
  };

  /** A runtime event, pushed as the runtime pushes one: the event, then the run's new summary. */
  const push = (event: WorkflowEventDto) => {
    publishWorkflowSignals(
      { type: 'run_event', event },
      { type: 'run_changed', summary: runtime.world().summary },
    );
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
            if (last) publishWorkflowSignals({ type: 'run_event', event: last });
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
          data-action="mount-terminal"
          aria-pressed={terminalMounted}
          className="rounded border border-line/40 px-1.5 py-0.5 font-mono text-fg-subtle"
          onClick={() => setTerminalMounted(true)}
        >
          Agent terminal
        </button>
        <button
          type="button"
          data-action="reconnect"
          className="rounded border border-line/40 px-1.5 py-0.5 font-mono text-fg-subtle"
          onClick={() => {
            publishWorkflowSignals({ type: 'disconnected' }, { type: 'connected' });
          }}
        >
          Reconnect
        </button>
      </div>

      {/* The work surface the inspector sits above, and the bar it opens from. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 p-3">
          <div className="flex h-full flex-col rounded-md border border-line/28 bg-terminal-surface/80 p-4 font-mono text-[12.5px] text-fg-muted">
            <p className="text-green">$ isagi run release-check</p>
            <p className="text-fg-subtle">the work surface this inspector sits above</p>
            {terminalMounted && <FakeAgentTerminal />}
          </div>
        </div>
        <WorkflowBarContainer inspectorEngineFactory={engine.factory} />
      </div>
    </main>
  );
}

/**
 * A stand-in for an agent terminal in the surface's active pane. Opt-in, so the specs about where
 * focus goes when there is no pane keep their meaning.
 *
 * It is the pane's registered focus target, as `PaneTerminal` is, and it consumes Escape the way
 * xterm's helper textarea does (sent to the agent, prevented and stopped), so an Escape typed while
 * it holds focus never reaches anything above it.
 */
function FakeAgentTerminal() {
  const registry = useRegistry();
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setActivePane(registry, FIXTURE_PLACEMENT.surfaceId, FIXTURE_PLACEMENT.paneId);
  }, [registry]);

  usePaneFocusTarget({
    surfaceId: FIXTURE_PLACEMENT.surfaceId,
    paneId: FIXTURE_PLACEMENT.paneId,
    priority: 100,
    focus: () => inputRef.current?.focus(),
  });

  return (
    <textarea
      ref={inputRef}
      aria-label="Agent terminal"
      data-fixture-terminal
      className="mt-2 min-h-0 flex-1 resize-none bg-transparent text-fg outline-none"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
      }}
    />
  );
}
