// Background synchronization: the debounced, latest-wins active-context persistence and the
// one-in-flight-per-project background reconcile.
import assert from 'node:assert/strict';
import { mock, test, type TestContext } from 'node:test';

import { Effect } from 'effect';

import type {
  ActiveContextOutput,
  ActiveContextPersistenceInput,
  ReconcileWorkspaceOutput,
} from '@isagi/contracts';

import { runApp } from '../../state/runtime.js';
import { advance, controllable, flush, makeTestRegistry } from '../../state/testing.js';
import { toastsAtom } from '../../toast/index.js';
import {
  scheduleActiveContextPersistence,
  scheduleWorkspaceReconcile,
} from '../background-sync.js';
import { activeContextAtom } from '../queries.js';
import { terminalFactsAtom } from '../terminal-presentation/facts.js';

const useMockTime = (t: TestContext) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 9_000_000 });
  t.after(() => mock.timers.reset());
};

const ok = {
  activeContext: { projectId: null, worktreeId: null },
} as unknown as ActiveContextOutput;

test('active context: 180 ms debounce, newer intent aborts the older request, only the latest reconciles', async (t) => {
  useMockTime(t);
  const writes = controllable<ActiveContextOutput>();
  const sent: ActiveContextPersistenceInput[] = [];
  const reconciled: Array<number | null> = [];
  const registry = makeTestRegistry({
    api: {
      // Recorded when the request actually runs, not when the effect is built.
      updateActiveContext: (input) => Effect.suspend(() => (sent.push(input), writes.effect)),
      reconcileWorkspace: (input) =>
        Effect.sync(() => {
          reconciled.push(input.projectId);
          return { findings: [] } as ReconcileWorkspaceOutput;
        }),
      fetchActiveContext: () => Effect.succeed(ok),
    },
  });
  t.after(() => registry.dispose());
  const schedule = (projectId: number) =>
    runApp(registry, scheduleActiveContextPersistence({ projectId, worktreeId: projectId * 10 }));

  await schedule(1);
  await advance(100);
  await schedule(2); // within the debounce: the first never leaves
  await advance(179);
  assert.equal(sent.length, 0, 'still debouncing');
  await advance(1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.activeContext.projectId, 2);

  await schedule(3); // while #2 is on the wire: #2 is aborted
  await flush();
  assert.equal(writes.calls[0]?.aborted, true, 'the superseded request is aborted');
  await advance(180);
  assert.equal(sent.length, 2);
  assert.ok(sent[1]!.revision > sent[0]!.revision, 'revisions are monotonic');

  writes.last().resolve(ok);
  await flush();
  assert.deepEqual(reconciled, [3], 'only the accepted latest reconciles its project');
  assert.deepEqual(registry.get(toastsAtom), [], 'superseded writes never toast');
});

test('an accepted active context re-reads the persisted active context', async (t) => {
  useMockTime(t);
  let reads = 0;
  const registry = makeTestRegistry({
    api: {
      updateActiveContext: () => Effect.succeed(ok),
      reconcileWorkspace: () => Effect.succeed({ findings: [] } as ReconcileWorkspaceOutput),
      fetchActiveContext: () => Effect.sync(() => (reads++, ok)),
    },
  });
  t.after(() => registry.dispose());
  t.after(registry.mount(activeContextAtom));
  await flush();
  assert.equal(reads, 1);

  await runApp(registry, scheduleActiveContextPersistence({ projectId: null, worktreeId: null }));
  await advance(180);

  assert.equal(reads, 2);
});

test('active context: a failed latest write toasts', async (t) => {
  useMockTime(t);
  const writes = controllable<ActiveContextOutput>();
  const registry = makeTestRegistry({ api: { updateActiveContext: () => writes.effect } });
  t.after(() => registry.dispose());

  await runApp(registry, scheduleActiveContextPersistence({ projectId: 1, worktreeId: 10 }));
  await advance(180);
  writes.last().reject(new Error('nope') as never);
  await flush();

  assert.deepEqual(
    registry.get(toastsAtom).map(({ id }) => id),
    ['active-context-persist-failed'],
  );
});

test('active context: a write the runtime does not answer within 5 s toasts and is abandoned', async (t) => {
  useMockTime(t);
  const writes = controllable<ActiveContextOutput>();
  const registry = makeTestRegistry({ api: { updateActiveContext: () => writes.effect } });
  t.after(() => registry.dispose());

  await runApp(registry, scheduleActiveContextPersistence({ projectId: 1, worktreeId: 10 }));
  await advance(180);
  await advance(4_999);
  assert.deepEqual(registry.get(toastsAtom), []);
  await advance(1);

  assert.equal(writes.last().aborted, true);
  assert.deepEqual(
    registry.get(toastsAtom).map(({ id }) => id),
    ['active-context-persist-failed'],
  );
});

test('reconcile: one in flight per project', async (t) => {
  const calls = controllable<ReconcileWorkspaceOutput>();
  const projects: Array<number | null> = [];
  const registry = makeTestRegistry({
    api: {
      reconcileWorkspace: (input) =>
        Effect.suspend(() => (projects.push(input.projectId), calls.effect)),
    },
  });
  t.after(() => registry.dispose());
  const reconcile = (projectId: number | null) =>
    runApp(registry, scheduleWorkspaceReconcile(projectId));

  await reconcile(1);
  await reconcile(1);
  await reconcile(2);
  await reconcile(null);
  await flush();
  assert.deepEqual(projects, [1, 2, null]);

  calls.calls[0]!.resolve({ findings: [] });
  await flush();
  await reconcile(1);
  await flush();
  assert.deepEqual(projects, [1, 2, null, 1], 'a settled project can be reconciled again');
});

test('reconcile: findings toast, then the inventory is asked to refresh', async (t) => {
  const facts: string[] = [];
  const registry = makeTestRegistry({
    api: {
      reconcileWorkspace: () =>
        Effect.succeed({
          findings: [{ kind: 'project_missing', projectId: 1, path: '/repo/gone' }],
        } as ReconcileWorkspaceOutput),
    },
  });
  t.after(() => registry.dispose());
  registry.get(terminalFactsAtom).subscribe((fact) => facts.push(fact.type));

  await runApp(registry, scheduleWorkspaceReconcile(1));
  await flush();

  assert.deepEqual(
    registry.get(toastsAtom).map(({ id }) => id),
    ['workspace-project-missing'],
  );
  assert.deepEqual(facts, ['durable_inventory_refresh_requested']);
});

test('reconcile: a failure is logged only and frees the project for the next attempt', async (t) => {
  let attempts = 0;
  const registry = makeTestRegistry({
    api: {
      reconcileWorkspace: () =>
        Effect.suspend(() => {
          attempts += 1;
          return Effect.fail(new Error('runtime unreachable')) as never;
        }),
    },
  });
  t.after(() => registry.dispose());

  await runApp(registry, scheduleWorkspaceReconcile(1));
  await flush();
  await runApp(registry, scheduleWorkspaceReconcile(1));
  await flush();

  assert.equal(attempts, 2);
  assert.deepEqual(registry.get(toastsAtom), []);
});
