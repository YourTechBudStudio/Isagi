import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { Effect } from 'effect';

import type {
  AgentSessionInteraction,
  SessionStatus,
  SurfaceDetail,
  WorkflowRunSummary,
} from '@isagi/shared/contracts';
import { RuntimeApiError } from '@isagi/shared/runtime-client';

import { fluidcastCopy, runtimeErrorCopy, surfaceActionsCopy } from '../../../copy/index.js';
import { runApp } from '../../state/runtime.js';
import { makeTestRegistry } from '../../state/testing.js';
import { formatRuntimeError, formatRuntimeErrorSummary } from '../../workspace/runtime-data.js';
import type { Surface } from '../../workspace/types.js';
import type { WorkflowSignal } from '../../workspace/workflow/live.js';
import { receiveWorkflowSignal } from '../../workspace/workflow/sync.js';
import { workflowSummaryFixture } from '../../workspace/workflow/test-support.js';
import { paletteTestSession } from '../test-support.js';
import type { PaletteContext } from '../types.js';
import {
  deleteActivePaneCommand,
  deleteActiveSurfaceCommand,
  deleteSurfaceReview,
  renameActiveSurfaceCommand,
  togglePaneInteractionCommand,
} from './surface-actions.js';

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  Reflect.deleteProperty(globalThis, 'window');
});

test('delete-active-pane preflight falls back to the first pane when no active pane is stored', async (t) => {
  const session = surfaceSession(t, surfaceDetail({ activePaneId: null }));

  const preflight = await deleteActivePaneCommand.preflight?.(
    {
      projects: [],
      ...session,
      launchableHarnesses: [],
      editorAvailable: false,
      activeProject: null,
      activeWorktree: {
        id: 10,
        projectId: 1,
        title: 'main',
        path: '/repo/isagi',
        branch: 'main',
        head: 'abcdef0',
        isRoot: true,
        attention: 'idle',
        parked: false,
        surfaces: [
          { id: 501, title: 'Terminal', paneKinds: ['terminal_session'], attention: 'idle' },
        ],
        activeSurfaceId: 501,
      },
      activeSurface: {
        id: 501,
        title: 'Terminal',
        paneKinds: ['terminal_session'],
        attention: 'idle',
      },
      activePaneId: null,
    },
    {},
  );

  assert.deepEqual(preflight, {
    mode: 'run',
    values: { worktreeId: '10', surfaceId: '501', paneId: '601' },
  });
});

test('rename-active-surface validation surfaces inline copy', async () => {
  let error: unknown;
  try {
    await renameActiveSurfaceCommand.run(
      { surfaceId: '501', title: '   ' },
      {
        projects: [],
        ...paletteTestSession(),
        launchableHarnesses: [],
        editorAvailable: false,
        activeProject: null,
        activeWorktree: null,
        activeSurface: {
          id: 501,
          title: 'Terminal',
          paneKinds: ['terminal_session'],
          attention: 'idle',
        },
        activePaneId: null,
      },
    );
  } catch (cause) {
    error = cause;
  }

  assert.equal(formatRuntimeError(error), 'Surface title cannot be empty.');
});

test('delete-active-pane preflight runs directly for a running fallback pane', async (t) => {
  const session = surfaceSession(
    t,
    surfaceDetail({ activePaneId: 602, firstStatus: 'exited', secondStatus: 'running' }),
  );

  const preflight = await deleteActivePaneCommand.preflight?.(
    {
      projects: [],
      ...session,
      launchableHarnesses: [],
      editorAvailable: false,
      activeProject: null,
      activeWorktree: {
        id: 10,
        projectId: 1,
        title: 'main',
        path: '/repo/isagi',
        branch: 'main',
        head: 'abcdef0',
        isRoot: true,
        attention: 'idle',
        parked: false,
        surfaces: [
          { id: 501, title: 'Terminal', paneKinds: ['terminal_session'], attention: 'idle' },
        ],
        activeSurfaceId: 501,
      },
      activeSurface: {
        id: 501,
        title: 'Terminal',
        paneKinds: ['terminal_session'],
        attention: 'idle',
      },
      activePaneId: null,
    },
    {},
  );

  assert.deepEqual(preflight, {
    mode: 'run',
    values: { worktreeId: '10', surfaceId: '501', paneId: '602' },
  });
});

test('delete-active-surface preflight runs directly without loading session status', async (t) => {
  const registry = makeTestRegistry({
    api: {
      getSurfaceDetail: () =>
        Effect.die(new Error('delete-active-surface preflight should not fetch surface detail')),
    },
  });
  t.after(() => registry.dispose());
  // The runtime's snapshot says no workflow is on any surface.
  await runApp(registry, receiveWorkflowSignal({ type: 'connected' }));
  await runApp(registry, receiveWorkflowSignal({ type: 'snapshot', summaries: [] }));

  const preflight = await deleteActiveSurfaceCommand.preflight?.(
    {
      projects: [],
      ...paletteTestSession(registry),
      launchableHarnesses: [],
      editorAvailable: false,
      activeProject: null,
      activeWorktree: {
        id: 10,
        projectId: 1,
        title: 'main',
        path: '/repo/isagi',
        branch: 'main',
        head: 'abcdef0',
        isRoot: true,
        attention: 'idle',
        parked: false,
        surfaces: [
          { id: 501, title: 'Terminal', paneKinds: ['terminal_session'], attention: 'idle' },
        ],
        activeSurfaceId: 501,
      },
      activeSurface: {
        id: 501,
        title: 'Terminal',
        paneKinds: ['terminal_session'],
        attention: 'idle',
      },
      activePaneId: 601,
    },
    {},
  );

  assert.deepEqual(preflight, {
    mode: 'run',
    values: { worktreeId: '10', surfaceId: '501' },
  });
});

/**
 * A palette context targeting surface 501 on worktree 10. With `runs`, the event connection opened
 * and its snapshot reported them, through the real live sync; without, no snapshot has arrived.
 */
async function deleteSurfaceContext(
  t: TestContext,
  runs: readonly WorkflowRunSummary[] | undefined,
): Promise<PaletteContext & { readonly send: (signal: WorkflowSignal) => Promise<void> }> {
  const registry = makeTestRegistry({ api: {} });
  t.after(() => registry.dispose());
  const send = (signal: WorkflowSignal) => runApp(registry, receiveWorkflowSignal(signal));
  if (runs !== undefined) {
    await send({ type: 'connected' });
    await send({ type: 'snapshot', summaries: runs });
  }
  return {
    projects: [],
    ...paletteTestSession(registry),
    launchableHarnesses: [],
    editorAvailable: false,
    activeProject: null,
    activeWorktree: null,
    activeSurface: null,
    activePaneId: null,
    send,
  };
}

const surface501 = { worktreeId: '10', surfaceId: '501' };

test('delete-active-surface confirms conservatively before the attached runs are known', async (t) => {
  const ctx = await deleteSurfaceContext(t, undefined);

  assert.deepEqual(await deleteActiveSurfaceCommand.preflight?.(ctx, surface501), {
    mode: 'palette',
    values: surface501,
  });
  const review = await deleteSurfaceReview(ctx, { surfaceId: 501 });
  const copy = surfaceActionsCopy.deleteSurface.unknownReview;
  assert.equal(review?.title, copy.title);
  assert.deepEqual(review?.items, []);
  assert.deepEqual(
    review?.choices.map((choice) => [choice.label, choice.intent]),
    [
      [copy.confirm, 'danger'],
      [copy.cancel, 'cancel'],
    ],
  );
});

test('delete-active-surface confirms conservatively while the event connection is down', async (t) => {
  // The last snapshot said the surface was empty; a workflow may have started since.
  const ctx = await deleteSurfaceContext(t, []);
  await ctx.send({ type: 'disconnected' });

  assert.deepEqual(await deleteActiveSurfaceCommand.preflight?.(ctx, surface501), {
    mode: 'palette',
    values: surface501,
  });
  assert.equal(
    (await deleteSurfaceReview(ctx, { surfaceId: 501 }))?.title,
    surfaceActionsCopy.deleteSurface.unknownReview.title,
  );
});

test('delete-active-surface confirms conservatively after a reconnect until its snapshot arrives', async (t) => {
  const ctx = await deleteSurfaceContext(t, []);
  await ctx.send({ type: 'disconnected' });
  await ctx.send({ type: 'connected' });
  // A changed summary before the snapshot is not the complete answer either.
  await ctx.send({
    type: 'run_changed',
    summary: workflowSummaryFixture({ runId: 3, status: 'running', surfaceId: 502 }),
  });

  assert.deepEqual(await deleteActiveSurfaceCommand.preflight?.(ctx, surface501), {
    mode: 'palette',
    values: surface501,
  });

  await ctx.send({ type: 'snapshot', summaries: [] });
  assert.deepEqual(await deleteActiveSurfaceCommand.preflight?.(ctx, surface501), {
    mode: 'run',
    values: surface501,
  });
});

test('delete-active-surface opens a review when an unfinished workflow is on the surface', async (t) => {
  for (const status of ['preparing', 'running', 'waiting', 'paused'] as const) {
    const ctx = await deleteSurfaceContext(t, [
      workflowSummaryFixture({ runId: 7, title: 'Review', status, surfaceId: 501 }),
    ]);

    assert.deepEqual(await deleteActiveSurfaceCommand.preflight?.(ctx, surface501), {
      mode: 'palette',
      values: surface501,
    });
    const review = await deleteSurfaceReview(ctx, { surfaceId: 501 });
    const copy = surfaceActionsCopy.deleteSurface.review;
    assert.equal(review?.title, copy.title);
    assert.deepEqual(review?.items, [{ label: copy.workflowLabel, detail: 'Review' }]);
    assert.deepEqual(
      review?.choices.map((choice) => [choice.label, choice.intent]),
      [
        [copy.confirm, 'danger'],
        [copy.cancel, 'cancel'],
      ],
    );
  }
});

test('delete-active-surface deletes at once when nothing unfinished is on the surface', async (t) => {
  const cases: (readonly WorkflowRunSummary[])[] = [
    [],
    // A finished run is only detached by the delete, so there is nothing to confirm.
    [workflowSummaryFixture({ status: 'completed', surfaceId: 501 })],
    [workflowSummaryFixture({ status: 'cancelled', surfaceId: 501 })],
    [workflowSummaryFixture({ status: 'failed', surfaceId: 501 })],
    // Another surface's run is not this delete's business.
    [workflowSummaryFixture({ status: 'running', surfaceId: 502 })],
  ];
  for (const runs of cases) {
    const ctx = await deleteSurfaceContext(t, runs);
    assert.deepEqual(await deleteActiveSurfaceCommand.preflight?.(ctx, surface501), {
      mode: 'run',
      values: surface501,
    });
    // The review is skipped too, should the run end while the palette is open.
    assert.equal(await deleteSurfaceReview(ctx, { surfaceId: 501 }), null);
  }
});

/** A palette session whose runtime answers surface 501's detail with `data`. */
function surfaceSession(t: TestContext, data: SurfaceDetail) {
  const registry = makeTestRegistry({
    api: {
      getSurfaceDetail: (surfaceId) =>
        Effect.sync(() => {
          assert.equal(surfaceId, 501);
          return data;
        }),
    },
  });
  t.after(() => registry.dispose());
  return paletteTestSession(registry);
}

function surfaceDetail({
  activePaneId,
  firstStatus = 'exited',
  secondStatus = 'exited',
}: {
  readonly activePaneId: number | null;
  readonly firstStatus?: SessionStatus;
  readonly secondStatus?: SessionStatus;
}): SurfaceDetail {
  return {
    id: 501,
    worktreeId: 10,
    title: 'Terminal',
    activePaneId,
    layout: { kind: 'leaf', nodeId: 'pane-601', paneId: 601, collapsed: false },
    panes: [
      {
        id: 601,
        surfaceId: 501,
        title: 'Terminal',
        sortOrder: 0,
        session: terminalSession(601, firstStatus),
      },
      {
        id: 602,
        surfaceId: 501,
        title: 'Terminal 2',
        sortOrder: 1,
        session: terminalSession(602, secondStatus),
      },
    ],
  };
}

function terminalSession(paneId: number, status: SessionStatus) {
  return {
    kind: 'terminal_session',
    terminalSession: {
      id: paneId + 100,
      paneId,
      worktreeId: 10,
      cwd: '/repo/isagi',
      shellCommand: 'zsh',
      shellArgs: [],
      status,
      processIncarnation: status === 'running' ? `pty:${paneId}` : null,
      statusReason: null,
      diagnosticCode: null,
      diagnosticDetail: null,
      createdAt: '2026-06-14T00:00:00.000Z',
      updatedAt: '2026-06-14T00:00:00.000Z',
      lastSeenAt: null,
    },
  } satisfies NonNullable<SurfaceDetail['panes'][number]['session']>;
}

// --- toggle-pane-interaction -------------------------------------------------------------------

const agentSurface = (interaction: AgentSessionInteraction): SurfaceDetail => ({
  id: 501,
  worktreeId: 10,
  title: 'Agent',
  activePaneId: 601,
  layout: { kind: 'leaf', nodeId: 'pane-601', paneId: 601, collapsed: false },
  panes: [
    {
      id: 601,
      surfaceId: 501,
      title: 'claude',
      sortOrder: 0,
      session: {
        kind: 'agent_session',
        agentSession: {
          id: 701,
          paneId: 601,
          worktreeId: 10,
          harness: 'claude',
          cwd: '/repo/isagi',
          harnessSessionId: null,
          statusReason: null,
          recoveryAction: 'connect_existing',
          interaction,
          status: 'running',
          processIncarnation: interaction.mode === 'terminal' ? 'pty:801' : null,
          diagnosticCode: null,
          diagnosticDetail: null,
          createdAt: '2026-06-17T00:00:00.000Z',
          updatedAt: '2026-06-17T00:00:00.000Z',
          lastSeenAt: null,
        },
      },
    },
  ],
});

function toggleContext(
  session: Pick<PaletteContext, 'registry' | 'app'>,
  paneKinds: Surface['paneKinds'],
): PaletteContext {
  return {
    projects: [],
    ...session,
    launchableHarnesses: [],
    editorAvailable: false,
    activeProject: null,
    activeWorktree: {
      id: 10,
      projectId: 1,
      title: 'main',
      path: '/repo/isagi',
      branch: 'main',
      head: 'abcdef0',
      isRoot: true,
      attention: 'idle',
      parked: false,
      surfaces: [{ id: 501, title: 'Agent', paneKinds, attention: 'idle' }],
      activeSurfaceId: 501,
    },
    activeSurface: { id: 501, title: 'Agent', paneKinds, attention: 'idle' },
    activePaneId: 601,
  };
}

test('toggle-pane-interaction is offered only on a surface that holds an agent pane', (t) => {
  const registry = makeTestRegistry();
  t.after(() => registry.dispose());
  const session = paletteTestSession(registry);
  assert.equal(
    togglePaneInteractionCommand.available?.(toggleContext(session, ['terminal_session'])),
    false,
  );
  assert.equal(
    togglePaneInteractionCommand.available?.(toggleContext(session, ['agent_session'])),
    true,
  );
});

test('toggle-pane-interaction explains a non-agent active pane in the palette instead of doing nothing', async (t) => {
  const session = surfaceSession(t, surfaceDetail({ activePaneId: 601 }));

  const error = await Promise.resolve(
    togglePaneInteractionCommand.preflight?.(toggleContext(session, ['agent_session']), {}),
  ).then(
    () => null,
    (cause: unknown) => cause,
  );

  assert.equal(formatRuntimeError(error), fluidcastCopy.notAnAgentPane);
});

for (const [interaction, target, from] of [
  [
    { mode: 'terminal', generation: 0, fluidcast: 'available' },
    'fluidcast',
    { generation: 0, fluidcastSessionId: null, processIncarnation: 'pty:801' },
  ],
  [
    { mode: 'terminal', generation: 2, fluidcast: 'unavailable' },
    'fluidcast',
    { generation: 2, fluidcastSessionId: null, processIncarnation: 'pty:801' },
  ],
  [
    { mode: 'fluidcast', generation: 3, fluidcastSessionId: 'fc-1' },
    'terminal',
    { generation: 3, fluidcastSessionId: 'fc-1', processIncarnation: null },
  ],
  [
    {
      mode: 'fluidcast_failed',
      generation: 4,
      failure: { code: 'fluidcast_start_failed', reason: 'executable_not_found' },
    },
    'terminal',
    { generation: 4, fluidcastSessionId: null, processIncarnation: null },
  ],
] as const) {
  test(`toggle-pane-interaction runs ${interaction.mode}${'fluidcast' in interaction ? `/${interaction.fluidcast}` : ''} -> ${target} from the read it decided on`, async (t) => {
    const session = surfaceSession(t, agentSurface(interaction));

    const preflight = await togglePaneInteractionCommand.preflight?.(
      toggleContext(session, ['agent_session']),
      {},
    );

    assert.deepEqual(preflight, {
      mode: 'run',
      values: {
        surfaceId: '501',
        worktreeId: '10',
        paneId: '601',
        agentSessionId: '701',
        mode: target,
      },
      payloads: { from },
    });
  });
}

const toggleValues = {
  surfaceId: '501',
  worktreeId: '10',
  paneId: '601',
  agentSessionId: '701',
  mode: 'fluidcast',
};
const terminalOrigin = { generation: 0, fluidcastSessionId: null, processIncarnation: 'pty:801' };

test('toggle-pane-interaction sends the preflight origin as the switch `from`', async (t) => {
  const calls: unknown[] = [];
  const registry = makeTestRegistry({
    api: {
      setAgentInteractionMode: (agentSessionId, input) =>
        Effect.sync(() => {
          calls.push([agentSessionId, input]);
          return { mode: input.mode, fluidcastSessionId: 'fc-1' };
        }),
    },
  });
  t.after(() => registry.dispose());
  const session = paletteTestSession(registry);

  await togglePaneInteractionCommand.run(toggleValues, toggleContext(session, ['agent_session']), {
    from: terminalOrigin,
  });

  assert.deepEqual(calls, [[701, { mode: 'fluidcast', from: terminalOrigin }]]);
});

for (const [label, payloads] of [
  ['no payloads', undefined],
  ['no origin', {}],
  ['a malformed origin', { from: { generation: -1, fluidcastSessionId: null } }],
] as const) {
  test(`toggle-pane-interaction does nothing with ${label}`, async (t) => {
    const registry = makeTestRegistry({ api: {} });
    t.after(() => registry.dispose());
    const session = paletteTestSession(registry);

    // The fake API dies on any call, so reaching the runtime would reject.
    await togglePaneInteractionCommand.run(
      toggleValues,
      toggleContext(session, ['agent_session']),
      payloads,
    );
  });
}

for (const reason of ['disabled', 'invalid_config', 'harness_unsupported'] as const) {
  test(`toggle-pane-interaction reports the runtime's ${reason} refusal as the palette error`, async (t) => {
    const refusal = new RuntimeApiError({
      endpointId: 'agent-sessions.set-interaction-mode',
      apiError: {
        code: 'fluidcast_unavailable',
        status: 409,
        message: 'diagnostic',
        requestId: 'r',
        data: { reason },
      } as never,
    });
    const calls: Array<readonly [number, string]> = [];
    const registry = makeTestRegistry({
      api: {
        setAgentInteractionMode: (agentSessionId, input) =>
          Effect.suspend(() => {
            calls.push([agentSessionId, input.mode]);
            return Effect.fail(refusal);
          }),
      },
    });
    t.after(() => registry.dispose());
    const session = paletteTestSession(registry);

    const error = await Promise.resolve(
      togglePaneInteractionCommand.run(
        {
          surfaceId: '501',
          worktreeId: '10',
          paneId: '601',
          agentSessionId: '701',
          mode: 'fluidcast',
        },
        toggleContext(session, ['agent_session']),
        { from: terminalOrigin },
      ),
    ).then(
      () => null,
      (cause: unknown) => cause,
    );

    assert.deepEqual(calls, [[701, 'fluidcast']]);
    assert.equal(formatRuntimeErrorSummary(error), runtimeErrorCopy.fromApiError(refusal.apiError));
  });
}
