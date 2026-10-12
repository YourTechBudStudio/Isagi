import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { Effect } from 'effect';
import { AsyncResult, type AtomRegistry } from 'effect/reactivity';

import {
  runtimeEventTypeSchema,
  type RuntimeEvent,
  type WorktreeCommandsOutput,
} from '@isagi/contracts';

import { keys } from '../../state/keys.js';
import { appReactivityAtom, runApp } from '../../state/runtime.js';
import {
  controllable,
  flush,
  makeTestRegistry,
  type TestRegistryOptions,
} from '../../state/testing.js';
import { commandLogMetadataAtom, surfaceDetailAtom, worktreeCommandsAtom } from '../queries.js';
import { handleRuntimeEvent } from '../runtime-events.js';
import { activePaneBySurfaceAtom, activeSurfaceByWorktreeAtom } from '../store.js';
import { terminalFactsAtom } from '../terminal-presentation/facts.js';
import { attachedRunsAtom, workflowEventsAtom, workflowRunAtom } from '../workflow/queries.js';
import {
  workflowEventFixture,
  workflowRunDetailFixture,
  workflowSummaryFixture,
} from '../workflow/test-support.js';

/** Every key an event could plausibly refresh, so "exactly these" is checkable. */
const watchedKeys = [
  keys.workspace,
  keys.activeContext,
  keys.surface(3),
  keys.surface(99),
  keys.commands(10),
  keys.commands(11),
  keys.commandLog(10, 'old dev'),
  keys.commandLog(10, 'other'),
  keys.controlPlane,
  keys.clientSettings,
  keys.workflowLive,
] as const;

function eventSession(t: TestContext, options: TestRegistryOptions = {}) {
  const registry = makeTestRegistry(options);
  t.after(() => registry.dispose());
  const refreshed = recordInvalidations(registry);
  const apply = (event: RuntimeEvent) => runApp(registry, handleRuntimeEvent(event));
  return { registry, refreshed, apply };
}

/** The watched keys an invalidation reached, in order. */
function recordInvalidations(registry: AtomRegistry.AtomRegistry) {
  const fired: string[] = [];
  const reactivity = AsyncResult.getOrThrow(registry.get(appReactivityAtom));
  for (const key of watchedKeys) {
    reactivity.registerUnsafe([key], () => fired.push(key));
  }
  return fired;
}

test('runtime session change events invalidate workspace and targeted surface queries', async (t) => {
  const { refreshed, apply } = eventSession(t);

  await apply(agentSessionChangedEvent());

  assert.deepEqual(refreshed, [keys.workspace, keys.surface(3)]);
});

test('an editor status change invalidates its surface detail and nothing else', async (t) => {
  const { refreshed, apply } = eventSession(t);

  await apply(editorContextChangedEvent());

  // Unlike the session cases: an editor status change alters nothing the
  // workspace snapshot carries. Placement still travels as `surface_changed`.
  assert.deepEqual(refreshed, [keys.surface(3)]);
});

test('surface pane delete events invalidate detail and clear matching active pane', async (t) => {
  const { registry, refreshed, apply } = eventSession(t, {
    initialValues: [
      [activeSurfaceByWorktreeAtom, { 2: 3 }],
      [activePaneBySurfaceAtom, { 3: 4, 99: 100 }],
    ],
  });

  await apply(surfacePaneDeletedEvent());

  assert.deepEqual(refreshed, [keys.workspace, keys.surface(3)]);
  assert.deepEqual(registry.get(activeSurfaceByWorktreeAtom), { 2: 3 });
  assert.deepEqual(registry.get(activePaneBySurfaceAtom), { 99: 100 });
});

test('surface deleted events refresh the workspace, leave the deleted detail unread, and clear active surface state', async (t) => {
  let detailReads = 0;
  const { registry, refreshed, apply } = eventSession(t, {
    api: {
      getSurfaceDetail: (surfaceId) =>
        Effect.sync(() => {
          detailReads += 1;
          return { id: surfaceId } as never;
        }),
    },
    initialValues: [
      [activeSurfaceByWorktreeAtom, { 2: 3, 20: 30 }],
      [activePaneBySurfaceAtom, { 3: 4, 99: 100 }],
    ],
  });
  t.after(registry.mount(surfaceDetailAtom(3)));
  await flush();

  await apply(surfaceDeletedEvent());
  await flush();

  // The detail stays in the cache, but nothing asks for it again.
  assert.deepEqual(refreshed, [keys.workspace]);
  assert.equal(detailReads, 1);
  assert.deepEqual(registry.get(activeSurfaceByWorktreeAtom), { 20: 30 });
  assert.deepEqual(registry.get(activePaneBySurfaceAtom), { 99: 100 });
});

/**
 * The exact keys are load-bearing: the catalog key must not reach any command's log metadata but
 * the changed command's, and must not reach another worktree's catalog. The refetch itself is the
 * sole route by which authoritative endpoint facts enter the cache.
 */
test('command change events patch status and invalidate command list and targeted metadata', async (t) => {
  const { registry, reads, apply } = await heldCatalog(t, {
    status: 'configured',
    worktreeId: 10,
    commands: [
      {
        name: 'old dev',
        status: 'running',
        ports: [
          {
            port: 5173,
            envVar: null,
            urls: [{ label: 'app', path: '/', url: 'http://localhost:5173/' }],
          },
        ],
      },
    ],
    removedCommands: [],
  });

  await apply(commandChangedEvent());

  const patched = catalogOf(registry) as {
    readonly commands: readonly { readonly name: string; readonly status: string }[];
  };
  assert.deepEqual(patched.commands, [{ name: 'old dev', status: 'failed', ports: [] }]);
  await flush();
  assert.deepEqual(reads, {
    'catalog:10': 1,
    'catalog:11': 0,
    'log:10:old dev': 1,
    'log:10:other': 0,
  });
});

test('command change events patch managed command status when config is malformed', async (t) => {
  const { registry, apply } = await heldCatalog(t, {
    status: 'config_error',
    worktreeId: 10,
    diagnostic: { code: 'command_config_invalid', path: '.isagi/config.yaml', message: 'bad' },
    managedCommands: [{ name: 'old dev', status: 'running', ports: [] }],
  });

  await apply(commandChangedEvent());

  const patched = catalogOf(registry) as {
    readonly managedCommands: readonly { readonly name: string; readonly status: string }[];
  };
  assert.deepEqual(patched.managedCommands, [{ name: 'old dev', status: 'failed', ports: [] }]);
});

test('workflow runtime events reach the workflow layer as signals, not a second store', async (t) => {
  const { registry, apply } = eventSession(t, {
    api: {
      getWorkflowRun: () =>
        Effect.succeed(workflowRunDetailFixture({ run: workflowSummaryFixture({ runId: 42 }) })),
      listWorkflowEvents: () => Effect.succeed({ items: [], nextCursor: null }),
    },
  });
  // The run view of run 42 is on screen.
  t.after(registry.mount(workflowRunAtom(42)));
  t.after(registry.mount(workflowEventsAtom(42)));
  await flush();

  const attached = workflowSummaryFixture({ runId: 42 });
  await apply({
    id: 'evt_workflow_snapshot',
    type: 'workflow_run_snapshot',
    occurredAt: '2026-06-12T00:00:00.000Z',
    payload: { summaries: [attached] },
  });
  assert.deepEqual(registry.get(attachedRunsAtom), [attached]);

  await apply({
    id: 'evt_workflow_changed',
    type: 'workflow_run_changed',
    occurredAt: '2026-06-12T00:00:01.000Z',
    payload: workflowSummaryFixture({ runId: 42, status: 'waiting' }),
  });
  assert.equal(registry.get(attachedRunsAtom)?.[0]?.status, 'waiting');
  const run = AsyncResult.getOrThrow(registry.get(workflowRunAtom(42)));
  assert.equal(run.run.status, 'waiting');

  await apply({
    id: 'evt_workflow_event',
    type: 'workflow_run_event',
    occurredAt: '2026-06-12T00:00:02.000Z',
    payload: workflowEventFixture({ runId: 42, eventId: 3 }),
  });
  // The workflow layer applied each fact; the handler forwards them and holds none of its own.
  const events = AsyncResult.getOrThrow(registry.get(workflowEventsAtom(42)));
  assert.deepEqual(
    events.map((row) => row.eventId),
    [3],
  );
});

/**
 * A status-only event can never authenticate resolved endpoint facts.
 *
 * The restart flow is the case that makes this load-bearing: the intermediate
 * stop is suppressed, so a `running → running` patch arrives while the cache
 * still holds the *dead* incarnation's ports. Keeping them would show a URL that
 * belongs to a process that no longer exists.
 */
test('a patch into running discards the previous incarnation resolved ports', async (t) => {
  const { registry, apply } = await heldCatalog(t, {
    status: 'configured',
    worktreeId: 10,
    commands: [
      {
        name: 'old dev',
        status: 'running',
        ports: [
          {
            port: 5173,
            envVar: 'API_PORT',
            urls: [{ label: 'app', path: '/', url: 'http://localhost:5173/' }],
          },
        ],
      },
    ],
    removedCommands: [],
  });

  await apply(commandChangedEvent('running'));

  const patched = catalogOf(registry) as {
    readonly commands: readonly { readonly status: string; readonly ports: unknown }[];
  };
  // Empty, never null: the patcher must not be able to write the authoritative
  // degraded value, or every ordinary launch would flash the "unavailable for
  // this run" notice until the refetch lands.
  assert.deepEqual(patched.commands, [{ name: 'old dev', status: 'running', ports: [] }]);
});

/**
 * One row per runtime event type. `satisfies Record<RuntimeEvent['type'], …>` makes a new event
 * type a compile error here until its row says what it refreshes; the runtime check below covers
 * the schema's literal list as well.
 */
const declaredRefreshes = {
  agent_session_changed: {
    event: agentSessionChangedEvent(),
    refreshes: [keys.workspace, keys.surface(3)],
  },
  terminal_session_changed: {
    event: {
      id: 'evt_terminal',
      type: 'terminal_session_changed',
      occurredAt: '2026-06-12T00:00:00.000Z',
      payload: {
        terminalSessionId: 5,
        worktreeId: 2,
        surfaceId: 3,
        paneId: 4,
        status: 'running',
        statusReason: null,
        diagnosticCode: null,
      },
    },
    refreshes: [keys.workspace, keys.surface(3)],
  },
  command_changed: {
    event: commandChangedEvent(),
    refreshes: [keys.commands(10), keys.commandLog(10, 'old dev')],
  },
  surface_changed: { event: surfaceRenamedEvent(), refreshes: [keys.workspace, keys.surface(3)] },
  attention_snapshot: {
    event: {
      id: 'evt_attention_snapshot',
      type: 'attention_snapshot',
      occurredAt: '2026-06-12T00:00:00.000Z',
      payload: { sources: [attentionSource()] },
    },
    refreshes: [],
  },
  attention_source_changed: {
    event: {
      id: 'evt_attention_changed',
      type: 'attention_source_changed',
      occurredAt: '2026-06-12T00:00:00.000Z',
      payload: attentionSource(),
    },
    refreshes: [],
  },
  attention_source_removed: {
    event: {
      id: 'evt_attention_removed',
      type: 'attention_source_removed',
      occurredAt: '2026-06-12T00:00:00.000Z',
      payload: { source: { kind: 'agent_session', id: 1 } },
    },
    refreshes: [],
  },
  workflow_run_snapshot: {
    event: {
      id: 'evt_workflow_snapshot',
      type: 'workflow_run_snapshot',
      occurredAt: '2026-06-12T00:00:00.000Z',
      payload: { summaries: [workflowSummaryFixture({ runId: 42 })] },
    },
    refreshes: [],
  },
  workflow_run_changed: {
    event: {
      id: 'evt_workflow_changed',
      type: 'workflow_run_changed',
      occurredAt: '2026-06-12T00:00:00.000Z',
      payload: workflowSummaryFixture({ runId: 42 }),
    },
    refreshes: [],
  },
  workflow_run_event: {
    event: {
      id: 'evt_workflow_event',
      type: 'workflow_run_event',
      occurredAt: '2026-06-12T00:00:00.000Z',
      payload: workflowEventFixture({ runId: 42, eventId: 3 }),
    },
    refreshes: [],
  },
  durable_session_deleted: {
    event: {
      id: 'evt_durable_deleted',
      type: 'durable_session_deleted',
      occurredAt: '2026-06-12T00:00:00.000Z',
      payload: { kind: 'agent_session', sessionId: 1, worktreeId: 2 },
    },
    refreshes: [],
  },
  editor_context_changed: { event: editorContextChangedEvent(), refreshes: [keys.surface(3)] },
} satisfies {
  readonly [Type in RuntimeEvent['type']]: {
    readonly event: Extract<RuntimeEvent, { readonly type: Type }>;
    readonly refreshes: readonly string[];
  };
};

test('every runtime event type refreshes exactly its declared resources', async (t) => {
  assert.deepEqual(
    Object.keys(declaredRefreshes).toSorted(),
    [...runtimeEventTypeSchema.literals].toSorted(),
    'one row per runtime event type',
  );
  for (const [type, row] of Object.entries(declaredRefreshes)) {
    const { registry, refreshed, apply } = eventSession(t);
    const facts: string[] = [];
    registry.get(terminalFactsAtom).subscribe((fact) => facts.push(fact.type));

    await apply(row.event);

    assert.deepEqual(refreshed, row.refreshes, `${type} refreshes exactly its declared keys`);
    // Every event also reaches the terminal coordinator, which keeps its own projection.
    assert.deepEqual(facts, ['runtime_event'], `${type} is published to the terminal facts`);
  }
});

/**
 * A session holding worktree 10's catalog (re-reads after the first stay in flight), the log
 * metadata of `old dev` and `other`, and worktree 11's catalog. `reads` counts the re-reads per
 * resource after the first load, which is how these tests see what an event refreshed: a second
 * invalidation handler on a held key would trip `invalidatedBy`'s re-registration, so they do not
 * use the key recorder.
 */
async function heldCatalog(t: TestContext, catalog: unknown) {
  const reread = controllable<WorktreeCommandsOutput>();
  let loaded = false;
  const reads: Record<string, number> = {};
  const count = (key: string) => (reads[key] = (reads[key] ?? 0) + 1);
  const registry = makeTestRegistry({
    api: {
      fetchWorktreeCommands: (worktreeId) =>
        Effect.suspend(() => {
          count(`catalog:${worktreeId}`);
          if (worktreeId !== 10) return Effect.succeed(emptyCatalog(worktreeId));
          if (loaded) return reread.effect;
          loaded = true;
          return Effect.succeed(catalog as WorktreeCommandsOutput);
        }),
      fetchCommandLogMetadata: (worktreeId, commandName) =>
        Effect.sync(() => {
          count(`log:${worktreeId}:${commandName}`);
          return { latestRun: null } as never;
        }),
    },
  });
  t.after(() => registry.dispose());
  t.after(registry.mount(worktreeCommandsAtom(10)));
  t.after(registry.mount(worktreeCommandsAtom(11)));
  t.after(registry.mount(commandLogMetadataAtom([10, 'old dev'])));
  t.after(registry.mount(commandLogMetadataAtom([10, 'other'])));
  await flush();
  for (const key of Object.keys(reads)) reads[key] = 0;
  const apply = (event: RuntimeEvent) => runApp(registry, handleRuntimeEvent(event));
  return { registry, reads, apply };
}

const emptyCatalog = (worktreeId: number) =>
  ({
    status: 'configured',
    worktreeId,
    commands: [],
    removedCommands: [],
  }) as unknown as WorktreeCommandsOutput;

/** The held catalog value (the patched one while the re-read is in flight). */
function catalogOf(registry: AtomRegistry.AtomRegistry) {
  return AsyncResult.getOrThrow(registry.get(worktreeCommandsAtom(10)));
}

function attentionSource() {
  return {
    worktreeId: 2,
    surfaceId: 3,
    paneId: 4,
    source: { kind: 'agent_session', id: 1 },
    attention: 'working',
  } as const;
}

function editorContextChangedEvent() {
  return {
    id: 'evt_test_editor',
    type: 'editor_context_changed',
    occurredAt: '2026-06-12T00:00:00.000Z',
    payload: { editorContextId: 7, worktreeId: 2, surfaceId: 3, paneId: 4 },
  } satisfies RuntimeEvent;
}

function agentSessionChangedEvent() {
  return {
    id: 'evt_test_1',
    type: 'agent_session_changed',
    occurredAt: '2026-06-12T00:00:00.000Z',
    payload: {
      agentSessionId: 1,
      worktreeId: 2,
      surfaceId: 3,
      paneId: 4,
      status: 'failed',
      statusReason: 'harness_metadata_missing',
      diagnosticCode: 'harness_metadata_missing',
    },
  } satisfies RuntimeEvent;
}

function commandChangedEvent(status: 'failed' | 'running' = 'failed') {
  return {
    id: 'evt_test_2',
    type: 'command_changed',
    occurredAt: '2026-06-19T00:00:00.000Z',
    payload: {
      worktreeId: 10,
      commandName: 'old dev',
      status,
    },
  } satisfies RuntimeEvent;
}

function surfaceRenamedEvent() {
  return {
    id: 'evt_test_renamed',
    type: 'surface_changed',
    occurredAt: '2026-06-19T00:00:00.000Z',
    payload: { worktreeId: 2, surfaceId: 3, change: 'renamed' },
  } satisfies RuntimeEvent;
}

function surfacePaneDeletedEvent() {
  return {
    id: 'evt_test_3',
    type: 'surface_changed',
    occurredAt: '2026-06-19T00:00:00.000Z',
    payload: {
      worktreeId: 2,
      surfaceId: 3,
      change: 'pane_deleted',
      deletedPaneIds: [4],
    },
  } satisfies RuntimeEvent;
}

function surfaceDeletedEvent() {
  return {
    id: 'evt_test_4',
    type: 'surface_changed',
    occurredAt: '2026-06-19T00:00:00.000Z',
    payload: {
      worktreeId: 2,
      surfaceId: 3,
      change: 'deleted',
      deletedPaneIds: [4],
    },
  } satisfies RuntimeEvent;
}
