import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { Effect, Logger } from 'effect';

import type { DeleteProjectOutput, WorkspaceSnapshot } from '@isagi/contracts';

import { toastCopy } from '../../../copy/index.js';
import { runApp } from '../../state/runtime.js';
import { controllable, flush } from '../../state/testing.js';
import { toastsAtom } from '../../toast/index.js';
import { commitDeleteProjectSuccess, deleteProjectFromPalette } from '../commits.js';
import { defaultSelection, reconcileSelection, type WorkspaceData } from '../model.js';
import { cachedWorkspaceData, workspaceAtom } from '../queries.js';
import { selectionAtom, setSelection } from '../store.js';
import type { WorkspaceSelection } from '../types.js';
import {
  heldProjectIds,
  holdWorkspace,
  project,
  recordFacts,
  refuse,
  snapshotOf,
  workspaceSession,
  worktree,
} from './test-support.js';

/**
 * The project-delete data path: one runtime call, the existing failure toast,
 * and a success commit that moves the selection itself so background
 * reconciliation never mistakes a deliberate delete for a vanished checkout.
 */

const doomed = project({
  id: 1,
  name: 'doomed',
  worktrees: [worktree({ id: 10, projectId: 1, isRoot: true }), worktree({ id: 11, projectId: 1 })],
});
const missingSibling = project({ id: 2, name: 'gone-elsewhere', status: 'missing' });
const healthy = project({ id: 3, name: 'healthy' });

/** A session holding `before`, whose next read answers `after`. */
async function seeded(
  t: TestContext,
  before: WorkspaceData['projects'],
  after: WorkspaceData['projects'],
  api: Parameters<typeof workspaceSession>[2] = {},
) {
  const session = workspaceSession(t, [{ projects: before }, { projects: after }], api);
  await holdWorkspace(t, session.registry);
  return session;
}

/** Collects the diagnostic log lines (their first message part) an effect writes. */
function captureLogs(lines: unknown[]) {
  return Logger.layer([
    Logger.make(({ message }) => {
      lines.push(Array.isArray(message) ? message[0] : message);
    }),
  ]);
}

test('success announces the cached worktrees before the refetch replaces them', async (t) => {
  const events: string[] = [];
  const { registry } = workspaceSession(t, [], {
    api: {
      fetchWorkspace: (() => {
        let reads = 0;
        return () =>
          Effect.sync(() => {
            if (reads++ === 0) return snapshotOf({ projects: [doomed, healthy] });
            events.push('fetch');
            return snapshotOf({ projects: [healthy] });
          });
      })(),
    },
  });
  await holdWorkspace(t, registry);
  const stop = recordFacts(registry, events);

  await runApp(registry, commitDeleteProjectSuccess(1));
  stop();

  assert.deepEqual(events, [
    'durable_worktree_deleted:10',
    'durable_worktree_deleted:11',
    'fetch',
    'durable_inventory_refresh_requested',
  ]);
  assert.deepEqual(heldProjectIds(registry), [3]);
});

for (const selection of [
  { kind: 'worktree', projectId: 1, worktreeId: 11 },
  { kind: 'missingProject', projectId: 1 },
] as const satisfies readonly WorkspaceSelection[]) {
  test(`a ${selection.kind} selection on the deleted project moves to the default`, async (t) => {
    const fresh = [missingSibling, healthy];
    const { registry } = await seeded(t, [doomed, ...fresh], fresh);
    setSelection(registry, selection);

    await runApp(registry, commitDeleteProjectSuccess(1));

    const next = registry.get(selectionAtom);
    assert.deepEqual(next, defaultSelection(heldProjects(registry)));
    assert.deepEqual(next, { kind: 'missingProject', projectId: 2 });
    assertReconcileIsQuiet(heldProjects(registry), next);
  });
}

test('a worktree selection lands on the next healthy root with no recovery warning', async (t) => {
  const { registry } = await seeded(t, [doomed, healthy], [healthy]);
  setSelection(registry, { kind: 'worktree', projectId: 1, worktreeId: 10 });

  await runApp(registry, commitDeleteProjectSuccess(1));

  const next = registry.get(selectionAtom);
  assert.deepEqual(next, { kind: 'worktree', projectId: 3, worktreeId: 30 });
  // `useWorkspaceSelectionSync` raises `active-worktree-recovered:*` only when it has
  // to change a worktree selection. Already reconciled, it has nothing to do.
  assertReconcileIsQuiet(heldProjects(registry), next);
});

test('a selection on another project is left alone', async (t) => {
  const elsewhere = { kind: 'worktree', projectId: 3, worktreeId: 30 } as const;
  const { registry } = await seeded(t, [doomed, healthy], [healthy]);
  setSelection(registry, elsewhere);

  await runApp(registry, commitDeleteProjectSuccess(1));

  assert.deepEqual(registry.get(selectionAtom), elsewhere);
});

test('deleting the only project leaves the empty workspace', async (t) => {
  const { registry } = await seeded(t, [doomed], []);
  setSelection(registry, { kind: 'worktree', projectId: 1, worktreeId: 10 });

  await runApp(registry, commitDeleteProjectSuccess(1));

  assert.deepEqual(registry.get(selectionAtom), { kind: 'empty' });
});

/**
 * A workspace read that began before the delete still lists the project. It is
 * cancelled, never supplies the commit's data, and cannot land afterwards to
 * leave the deleted project selected.
 */
test(
  'a workspace read already in flight before the delete cannot supply the commit',
  { timeout: 5_000 },
  async (t) => {
    const stale = controllable<WorkspaceSnapshot>();
    const reads: string[] = [];
    let index = 0;
    const { registry } = workspaceSession(t, [], {
      api: {
        fetchWorkspace: () =>
          Effect.suspend(() => {
            index += 1;
            if (index === 1) return Effect.succeed(snapshotOf({ projects: [doomed, healthy] }));
            if (index === 2) {
              reads.push('stale');
              return stale.effect;
            }
            reads.push('fresh');
            return Effect.succeed(snapshotOf({ projects: [healthy] }));
          }),
      },
    });
    const release = await holdWorkspace(t, registry);
    setSelection(registry, { kind: 'worktree', projectId: 1, worktreeId: 11 });
    // A focus refetch, say: in flight when the delete settles.
    registry.refresh(workspaceAtom);
    await flush();
    assert.deepEqual(reads, ['stale']);

    await runApp(registry, commitDeleteProjectSuccess(1));

    assert.deepEqual(reads, ['stale', 'fresh']);
    assert.equal(stale.last().aborted, true, 'the pre-delete read was cancelled');
    assert.deepEqual(registry.get(selectionAtom), {
      kind: 'worktree',
      projectId: 3,
      worktreeId: 30,
    });

    // The cancelled read answering late must not put the deleted project back.
    stale.last().resolve(snapshotOf({ projects: [doomed, healthy] }));
    await flush();
    assert.deepEqual(heldProjectIds(registry), [3]);
    release();
  },
);

test('a refused delete shows the existing toast, refreshes, and resolves', async (t) => {
  const { registry, reads } = await seeded(t, [doomed], [doomed], {
    api: { deleteProject: () => refuse('gate refused') },
  });
  const logged: unknown[] = [];

  await runApp(registry, deleteProjectFromPalette(1).pipe(Effect.provide(captureLogs(logged))));

  const toast = registry.get(toastsAtom).find(({ id }) => id === 'delete-project-failed:1');
  assert.equal(toast?.title, toastCopy.projectDeleteFailed.title);
  assert.equal(toast?.title, 'Could not delete the project.');
  assert.deepEqual(logged, ['[workspace] project deletion failed']);
  assert.equal(reads(), 2, 'the held workspace was re-read');
});

test('a successful delete commits with a fresh read and shows no toast', async (t) => {
  const calls: number[] = [];
  const { registry, reads } = await seeded(t, [doomed, healthy], [], {
    api: {
      deleteProject: (projectId) =>
        Effect.sync(() => {
          calls.push(projectId);
          return { projectId, deleted: false } satisfies DeleteProjectOutput;
        }),
    },
  });
  setSelection(registry, { kind: 'worktree', projectId: 1, worktreeId: 11 });
  const events: string[] = [];
  const stop = recordFacts(registry, events);

  await runApp(registry, deleteProjectFromPalette(1));
  stop();

  // `{ deleted: false }` is still success: the project is not there either way.
  assert.deepEqual(calls, [1]);
  assert.equal(reads(), 2, 'exactly one fresh workspace read');
  assert.deepEqual(events, [
    'durable_worktree_deleted:10',
    'durable_worktree_deleted:11',
    'durable_inventory_refresh_requested',
  ]);
  assert.deepEqual(registry.get(selectionAtom), { kind: 'empty' });
  assert.equal(registry.get(toastsAtom).length, 0);
});

function heldProjects(registry: Parameters<typeof heldProjectIds>[0]) {
  return cachedWorkspaceData(registry)?.projects ?? [];
}

function assertReconcileIsQuiet(
  projects: WorkspaceData['projects'],
  selection: WorkspaceSelection,
) {
  assert.deepEqual(reconcileSelection(projects, selection), selection);
}
