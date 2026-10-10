import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { Effect } from 'effect';

import type { ActiveContextOutput, WorkspaceSnapshot } from '@isagi/contracts';

import { defaultRetry, queryRetryAtom } from '../../state/policy.js';
import { runApp } from '../../state/runtime.js';
import { controllable, flush } from '../../state/testing.js';
import { runProjectRecheck } from '../commits.js';
import type { WorkspaceData } from '../model.js';
import { activeContextAtom, cachedWorkspaceData, workspaceAtom } from '../queries.js';
import { terminalFactsAtom } from '../terminal-presentation/facts.js';
import {
  holdWorkspace,
  project,
  recordFacts,
  refuse,
  snapshotOf,
  workspace,
  workspaceSession,
} from './test-support.js';

const FOLDER = 7;

function missingWorkspace(): WorkspaceData {
  return workspace([project({ id: FOLDER, name: 'notes', kind: 'folder', status: 'missing' })]);
}

function presentWorkspace(): WorkspaceData {
  return workspace([project({ id: FOLDER, name: 'notes', kind: 'folder' })]);
}

/**
 * A session with a fake runtime: `reconcile` and `read` stand in for the reconcile endpoint and
 * every workspace read after the optional `held` one.
 */
async function recheckSession(
  t: TestContext,
  input: {
    readonly held?: WorkspaceData | undefined;
    readonly reconcile?: (projectId: number | null) => Effect.Effect<void, never>;
    readonly read: () => Effect.Effect<WorkspaceSnapshot, never>;
  },
) {
  let reads = 0;
  const session = workspaceSession(t, [], {
    api: {
      reconcileWorkspace: (body) =>
        Effect.as(input.reconcile?.(body.projectId) ?? Effect.void, { findings: [] }),
      fetchWorkspace: () =>
        Effect.suspend(() =>
          reads++ === 0 && input.held !== undefined
            ? Effect.succeed(snapshotOf(input.held))
            : input.read(),
        ),
    },
  });
  if (input.held !== undefined) await holdWorkspace(t, session.registry);
  return session.registry;
}

test('a reconcile that restores the folder settles as restored', async (t) => {
  const seen: Array<number | null> = [];
  const registry = await recheckSession(t, {
    held: missingWorkspace(),
    reconcile: (projectId) => Effect.sync(() => void seen.push(projectId)),
    read: () => Effect.succeed(snapshotOf(presentWorkspace())),
  });

  const result = await runApp(registry, runProjectRecheck(FOLDER));

  assert.deepEqual(result, { status: 'restored', projectId: FOLDER });
  // The reconcile is scoped to the project the user is looking at, never a global sweep.
  assert.deepEqual(seen, [FOLDER]);
});

test('a folder that is genuinely still absent settles as still_unavailable', async (t) => {
  const registry = await recheckSession(t, {
    held: missingWorkspace(),
    read: () => Effect.succeed(snapshotOf(missingWorkspace())),
  });

  const result = await runApp(registry, runProjectRecheck(FOLDER));

  assert.deepEqual(result, { status: 'still_unavailable', projectId: FOLDER });
});

test('a project absent from the fresh snapshot is still_unavailable, not restored', async (t) => {
  const registry = await recheckSession(t, {
    read: () => Effect.succeed(snapshotOf(workspace([]))),
  });

  const result = await runApp(registry, runProjectRecheck(FOLDER));

  assert.deepEqual(result, { status: 'still_unavailable', projectId: FOLDER });
});

test('a failed reconcile rejects and never reads the workspace', async (t) => {
  let reads = 0;
  const registry = await recheckSession(t, {
    reconcile: () => refuse('reconcile refused'),
    read: () =>
      Effect.sync(() => {
        reads += 1;
        return snapshotOf(presentWorkspace());
      }),
  });
  const facts: string[] = [];
  const stop = recordFacts(registry, facts);

  await assert.rejects(runApp(registry, runProjectRecheck(FOLDER)), /reconcile refused/);

  assert.equal(reads, 0);
  assert.deepEqual(facts, []);
  stop();
});

test('a failed read after a successful reconcile rejects, and never reports absence', async (t) => {
  // The dangerous starting point: the cache still says missing, so anything that
  // fell back to it would answer "still not there" on a read that never happened.
  const registry = await recheckSession(t, {
    held: missingWorkspace(),
    read: () => refuse('the runtime dropped the read'),
  });
  const facts: string[] = [];
  const stop = recordFacts(registry, facts);

  await assert.rejects(runApp(registry, runProjectRecheck(FOLDER)), /the runtime dropped the read/);

  // No verdict, and no inventory fact: the refresh never succeeded, so nothing
  // downstream should be told the inventory is worth re-reading.
  assert.deepEqual(facts, []);
  stop();
});

test('a fresh read is performed even when the cache already holds a missing snapshot', async (t) => {
  let reads = 0;
  const registry = await recheckSession(t, {
    held: missingWorkspace(),
    read: () =>
      Effect.sync(() => {
        reads += 1;
        return snapshotOf(presentWorkspace());
      }),
  });

  const result = await runApp(registry, runProjectRecheck(FOLDER));

  // A cached missing snapshot never settles as a negative result without the runtime being asked.
  assert.equal(reads, 1);
  assert.deepEqual(result, { status: 'restored', projectId: FOLDER });
  assert.deepEqual(
    cachedWorkspaceData(registry)?.projects.map(({ id, status }) => [id, status]),
    [[FOLDER, 'present']],
  );
});

test('the inventory fact is published exactly once, after the successful read', async (t) => {
  const order: string[] = [];
  const registry = await recheckSession(t, {
    reconcile: () => Effect.sync(() => void order.push('reconcile')),
    read: () =>
      Effect.sync(() => {
        order.push('read');
        return snapshotOf(presentWorkspace());
      }),
  });
  const stop = registry.get(terminalFactsAtom).subscribe((fact) => order.push(`fact:${fact.type}`));

  await runApp(registry, runProjectRecheck(FOLDER));

  assert.deepEqual(order, ['reconcile', 'read', 'fact:durable_inventory_refresh_requested']);
  stop();
});

/**
 * The defect the cancel-then-read exists for: a read that started *before* the
 * reconcile (a window-focus refetch, say) must not supply the verdict, or a folder
 * that genuinely came back is reported as still absent.
 */
test(
  'a read already in flight before the reconcile cannot supply the verdict',
  { timeout: 5_000 },
  async (t) => {
    const stale = controllable<WorkspaceSnapshot>();
    const reads: string[] = [];
    let index = 0;
    const session = workspaceSession(t, [], {
      api: {
        reconcileWorkspace: () => Effect.succeed({ findings: [] }),
        fetchWorkspace: () =>
          Effect.suspend(() => {
            index += 1;
            if (index === 1) {
              reads.push('stale');
              return stale.effect;
            }
            reads.push('fresh');
            return Effect.succeed(snapshotOf(presentWorkspace()));
          }),
      },
    });
    const registry = session.registry;
    // The pre-reconcile read, exactly as a window-focus refetch would leave in flight while the
    // user clicks Check again. It would answer with the *pre*-reconcile world: still missing.
    t.after(registry.mount(workspaceAtom));
    await flush();
    assert.deepEqual(reads, ['stale']);

    const result = await runApp(registry, runProjectRecheck(FOLDER));

    // The verdict came from a read that began after the reconcile, not the one already running.
    assert.deepEqual(reads, ['stale', 'fresh']);
    assert.deepEqual(result, { status: 'restored', projectId: FOLDER });
    assert.equal(stale.last().aborted, true);

    // The cancelled read completing late must not overwrite the fresh value. The runtime may well
    // have finished its work — cancellation is client-side — so this is the property that matters.
    stale.last().resolve(snapshotOf(missingWorkspace()));
    await flush();
    assert.deepEqual(
      cachedWorkspaceData(registry)?.projects.map(({ status }) => status),
      ['present'],
    );
  },
);

test('the cancellation leaves the active-context query alone', async (t) => {
  const activeContext = controllable<ActiveContextOutput>();
  const staleWorkspace = controllable<WorkspaceSnapshot>();
  let workspaceReads = 0;
  const session = workspaceSession(t, [], {
    api: {
      reconcileWorkspace: () => Effect.succeed({ findings: [] }),
      fetchActiveContext: () => activeContext.effect,
      fetchWorkspace: () =>
        Effect.suspend(() =>
          workspaceReads++ === 0
            ? staleWorkspace.effect
            : Effect.succeed(snapshotOf(presentWorkspace())),
        ),
    },
  });
  const registry = session.registry;
  t.after(registry.mount(activeContextAtom));
  t.after(registry.mount(workspaceAtom));
  await flush();

  await runApp(registry, runProjectRecheck(FOLDER));

  // The workspace and the active context are separate keys: cancelling the workspace read never
  // touches the active-context request that is still in flight.
  assert.equal(activeContext.last().aborted, false);
  assert.equal(staleWorkspace.last().aborted, true);
  activeContext.last().resolve({ activeContext: { projectId: 1, worktreeId: 10 } } as never);
  await flush();
  assert.equal(registry.get(activeContextAtom)._tag, 'Success');
});

/**
 * The old read-after-write was `fetchQuery`, which never retried: the check reports its failure at
 * once rather than after the workspace query's 1 s / 2 s / 4 s retries (none of the time below
 * passes). The query's own reads keep retrying.
 */
test('a failed fresh read reports at once, without the query retries', async (t) => {
  let reads = 0;
  const session = workspaceSession(t, [], {
    retry: true,
    api: {
      reconcileWorkspace: () => Effect.succeed({ findings: [] }),
      fetchWorkspace: () =>
        Effect.suspend(() => {
          reads += 1;
          return refuse('the runtime dropped the read');
        }),
    },
  });

  await assert.rejects(
    runApp(session.registry, runProjectRecheck(FOLDER)),
    /the runtime dropped the read/,
  );

  assert.equal(reads, 1);
  assert.equal(session.registry.get(queryRetryAtom), defaultRetry, 'the retry switch is restored');
});
