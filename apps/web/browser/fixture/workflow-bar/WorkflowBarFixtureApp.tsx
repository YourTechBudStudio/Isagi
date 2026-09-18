import { QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { queryClient } from '../../../src/lib/query/client.js';
import { useWorkspace } from '../../../src/lib/workspace/hooks.js';
import { useWorkspaceStore } from '../../../src/lib/workspace/store.js';
import {
  useAttachedWorkflowRunsQuery,
  useRuntimeIdentity,
  useWorkflowRuntimeSync,
} from '../../../src/lib/workspace/workflow/queries.js';
import { publishWorkflowSignal } from '../../../src/lib/workspace/workflow/signals.js';
import { CommandPalette } from '../../../src/routes/workspace/CommandPalette.js';
import { Surface } from '../../../src/routes/workspace/Surface.js';
import { WorkflowBarContainer } from '../../../src/routes/workspace/WorkflowBarContainer.js';
import {
  FIXTURE_PLACEMENT,
  fixtureSummary,
  type WorkflowBarRuntimeControls,
} from './fake-runtime.js';

type Scenario = Parameters<typeof fixtureSummary>[0];

/** The next live revision the fixture will publish, so a spec can keep adding one more line. */
let nextLogRevision = 1;

/** Live diagnostics for the attached run, exactly as the runtime would publish them. */
function publishLogLines(from: number, to: number) {
  nextLogRevision = Math.max(nextLogRevision, to + 1);
  for (let revision = from; revision <= to; revision += 1) {
    publishWorkflowSignal({
      type: 'transition',
      delta: {
        runId: 77,
        revision,
        transition: {
          revision,
          recordedAt: '2026-09-15T10:00:00.000Z',
          kind: 'log',
          frameId: 1,
          executionId: 1,
          attemptId: null,
          operationKey: null,
          waitId: null,
          artifactHash: null,
          detailRef: {
            inline: { source: 'author_log', level: 'info', message: `recorded line ${revision}` },
          },
          stateRef: null,
        },
        changes: { executions: [], frames: [], operations: [] },
      },
    });
  }
}

/**
 * The **production** `WorkflowBarContainer` over a fake runtime boundary.
 *
 * Nothing between the bar and `fetch` is stubbed: the container resolves its run from the real
 * attached-run cache, its controls go through the real mutations and the real client, and a refusal
 * comes back through the real error mapping. A props-driven page would have rendered the same
 * pixels while testing none of that.
 *
 * Attachment facts are published as runtime signals rather than seeded into the cache, so
 * `AttachedRunsSync` — including its snapshot/changed/detached ordering rules — is exercised too.
 */
export function WorkflowBarFixtureApp({
  runtime,
}: {
  readonly runtime: WorkflowBarRuntimeControls;
}) {
  useEffect(() => {
    const store = useWorkspaceStore.getState();
    store.setActiveSurface(FIXTURE_PLACEMENT.worktreeId, FIXTURE_PLACEMENT.surfaceId);
    store.selectWorktree(FIXTURE_PLACEMENT.projectId, FIXTURE_PLACEMENT.worktreeId);
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <FixtureShell runtime={runtime} />
    </QueryClientProvider>
  );
}

function FixtureShell({ runtime }: { readonly runtime: WorkflowBarRuntimeControls }) {
  useWorkflowRuntimeSync();
  const runtimeIdentity = useRuntimeIdentity();
  // Read through the same query the container reads, so what the page reports is what the bar sees
  // rather than a second snapshot taken at a different moment.
  const attachedRuns = useAttachedWorkflowRunsQuery().data ?? [];
  const recorded = useSyncExternalStore(runtime.subscribe, runtime.requests);
  const [scenario, setScenario] = useState<Scenario>('waiting_input');
  const [waitId, setWaitId] = useState(5);
  const [revision, setRevision] = useState(1);
  // Zen mode unmounts the bar entirely, so the page has to be able to reproduce that: the React
  // Query cache outlives the component, and anything the bar remembers locally does not.
  const [barMounted, setBarMounted] = useState(true);

  // Published, not written: the snapshot is how a real client learns which runs occupy a surface.
  // It waits for the runtime identity because `AttachedRunsSync` only subscribes once it has one,
  // and a snapshot published before that subscription would be delivered to nobody — the same
  // ordering rule the coordinator follows, for the same reason.
  useEffect(() => {
    if (runtimeIdentity === null) return;
    publishWorkflowSignal({ type: 'connected' });
    publishWorkflowSignal({
      type: 'snapshot',
      summaries: [fixtureSummary('waiting_input', { waitId: 5, revision: 1 })],
    });
    // Later changes arrive as the incremental events a runtime would actually send.
  }, [runtimeIdentity]);

  return (
    <main className="flex h-screen flex-col bg-canvas text-fg" data-workflow-bar-fixture>
      <div className="flex flex-none flex-wrap gap-2 p-3">
        {(['waiting_input', 'paused_continue', 'failed', 'done'] as const).map((value) => (
          <button
            key={value}
            type="button"
            data-action={`scenario-${value}`}
            onClick={() => {
              const nextRevision = revision + 1;
              setScenario(value);
              setRevision(nextRevision);
              publishWorkflowSignal({
                type: 'run_changed',
                summary: fixtureSummary(value, { waitId, revision: nextRevision }),
              });
            }}
          >
            {value}
          </button>
        ))}
        <button
          type="button"
          data-action="change-wait"
          onClick={() => {
            const nextWaitId = waitId + 1;
            const nextRevision = revision + 1;
            setWaitId(nextWaitId);
            setRevision(nextRevision);
            publishWorkflowSignal({
              type: 'run_changed',
              summary: fixtureSummary(scenario, { waitId: nextWaitId, revision: nextRevision }),
            });
          }}
        >
          Change wait
        </button>
        <button
          type="button"
          data-action="reject-next"
          onClick={() => runtime.rejectNextControl('workflow_stale_control')}
        >
          Reject next control
        </button>
        <button
          type="button"
          data-action="stale-detach"
          onClick={() =>
            // A detach for a run that no longer holds this surface. It must change nothing.
            publishWorkflowSignal({
              type: 'run_detached',
              runId: 11,
              surfaceId: FIXTURE_PLACEMENT.surfaceId,
            })
          }
        >
          Stale detach
        </button>
        <button
          type="button"
          data-action="detach"
          onClick={() =>
            publishWorkflowSignal({
              type: 'run_detached',
              runId: 77,
              surfaceId: FIXTURE_PLACEMENT.surfaceId,
            })
          }
        >
          Detach
        </button>
        <button
          type="button"
          data-action="stale-summary"
          onClick={() =>
            // An older revision for the same run, arriving late. It must not win.
            publishWorkflowSignal({
              type: 'run_changed',
              summary: fixtureSummary('done', { revision: 1 }),
            })
          }
        >
          Stale summary
        </button>
        <button type="button" data-action="seed-log" onClick={() => runtime.setLogLines(8)}>
          Seed log
        </button>
        <button
          type="button"
          data-action="high-revision"
          onClick={() =>
            // A long-lived run. The window has to be derived from where the run is, not from zero.
            publishWorkflowSignal({
              type: 'run_changed',
              summary: fixtureSummary('waiting_input', { waitId, revision: 1000 }),
            })
          }
        >
          High revision
        </button>
        <button
          type="button"
          data-action="swap-high-revision"
          onClick={() => {
            publishWorkflowSignal({
              type: 'run_changed',
              summary: fixtureSummary('waiting_input', { runId: 88, waitId: 5, revision: 2000 }),
            });
            publishWorkflowSignal({
              type: 'run_detached',
              runId: 77,
              surfaceId: FIXTURE_PLACEMENT.surfaceId,
            });
          }}
        >
          Swap to high revision
        </button>
        <button type="button" data-action="flood-log" onClick={() => publishLogLines(1, 200)}>
          Flood log to the cap
        </button>
        <button
          type="button"
          data-action="one-more-line"
          onClick={() => publishLogLines(nextLogRevision, nextLogRevision)}
        >
          One more line
        </button>
        <button type="button" data-action="hold-control" onClick={runtime.holdNextControl}>
          Hold next control
        </button>
        <button type="button" data-action="release-control" onClick={runtime.releaseHeldControl}>
          Release control
        </button>
        <button
          type="button"
          data-action="toggle-bar"
          onClick={() => setBarMounted((mounted) => !mounted)}
        >
          Toggle bar mount
        </button>
        <button type="button" data-action="hold-log" onClick={runtime.holdNextLogRead}>
          Hold next log read
        </button>
        <button type="button" data-action="release-log" onClick={runtime.releaseHeldLogRead}>
          Release log read
        </button>
        <button type="button" data-action="grow-log" onClick={() => runtime.setLogLines(12)}>
          Grow log history
        </button>
        <button type="button" data-action="fail-log" onClick={runtime.failNextLogRead}>
          Fail next log read
        </button>
        <button
          type="button"
          data-action="stored-detail"
          onClick={() => {
            runtime.setLogLines(1);
            runtime.setStoredLogDetail(true);
          }}
        >
          Stored detail
        </button>
        <button
          type="button"
          data-action="swap-run"
          onClick={() => {
            // A different run takes the same surface, exactly as a relaunch would.
            publishWorkflowSignal({
              type: 'run_changed',
              summary: fixtureSummary('waiting_input', { runId: 88, waitId: 5, revision: 1 }),
            });
            publishWorkflowSignal({
              type: 'run_detached',
              runId: 77,
              surfaceId: FIXTURE_PLACEMENT.surfaceId,
            });
          }}
        >
          Swap run
        </button>
      </div>
      {runtimeIdentity !== null && <div data-fixture-ready />}
      <output className="sr-only" data-requests>
        {JSON.stringify(recorded)}
      </output>
      <output className="sr-only" data-attached>
        {JSON.stringify(
          attachedRuns.map((run) => ({
            runId: run.runId,
            revision: run.revision,
            status: run.status,
          })),
        )}
      </output>
      {/*
        The three production readers of the attached-run cache, on one page and one QueryClient.
        None of them is given the summary: each resolves it through the same query, which is the
        only way to show that they cannot drift apart.
      */}
      <SurfaceAttentionProbe />
      <div className="h-48 flex-none p-3" data-surface-host>
        <ActiveSurface />
      </div>
      <div className="mt-auto">{barMounted && <WorkflowBarContainer />}</div>
      <CommandPalette />
    </main>
  );
}

/**
 * The surface the run is attached to, rendered by the production component.
 *
 * Its own `useAttachedWorkflowRun` decides whether the workflow glow is there at all, so the glow's
 * presence is the surface half of "both readers see the same run".
 */
function ActiveSurface() {
  const { activeWorktree, activeSurface } = useWorkspace();
  if (!activeWorktree || !activeSurface) return null;
  return <Surface surface={activeSurface} />;
}

/**
 * The attention the rail and the surface presentation both consume, taken from the production
 * derivation rather than from a colour class.
 */
function SurfaceAttentionProbe() {
  const { projects } = useWorkspace();
  const attention = projects[0]?.worktrees[0]?.surfaces[0]?.attention ?? null;
  const worktreeAttention = projects[0]?.worktrees[0]?.attention ?? null;
  return (
    <output className="sr-only" data-attention>
      {JSON.stringify({ surface: attention, worktree: worktreeAttention })}
    </output>
  );
}
