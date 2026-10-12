// What components read from a mutation fn atom: pending, error,
// reset, a rerun hiding the old error, the per-call `onError` equivalent, and that a write is
// never aborted by its component going away.
import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Exit } from 'effect';
import { Atom, AtomRegistry } from 'effect/reactivity';

import type { CommandActionOutput } from '@isagi/contracts';

import { mutationData, mutationError } from '../../state/result.js';
import { controllable, flush, makeTestRegistry } from '../../state/testing.js';
import { commandActionAtoms, makeRecheckProjectAtom } from '../queries.js';
import { project, snapshotOf } from './test-support.js';

test('Atom.fn: waiting = isPending, Failure = error, Reset clears; unmount does not abort an uninterruptible write', async (t) => {
  const runs = controllable<CommandActionOutput>();
  const registry = makeTestRegistry({
    api: {
      runCommand: () => runs.effect,
      fetchWorktreeCommands: () => Effect.succeed({ status: 'configured' } as never),
      fetchCommandLogMetadata: () => Effect.succeed({ latestRun: null } as never),
    },
  });
  t.after(() => registry.dispose());
  const run = commandActionAtoms(10).run;
  let unmount = registry.mount(run);

  assert.equal(registry.get(run)._tag, 'Initial');
  assert.equal(registry.get(run).waiting, false);
  registry.set(run, 'dev');
  assert.equal(registry.get(run).waiting, true, 'isPending');

  runs.last().reject(new Error('bad') as never);
  await flush();
  assert.equal(registry.get(run)._tag, 'Failure');
  assert.equal((mutationError(registry.get(run)) as Error | null)?.message, 'bad');

  // A rerun after a failure is `Failure` + waiting; the old error is hidden while it runs, as
  // React Query cleared `error` at mutate start.
  registry.set(run, 'dev');
  assert.equal(registry.get(run)._tag, 'Failure');
  assert.equal(registry.get(run).waiting, true);
  assert.equal(mutationError(registry.get(run)), null);
  runs.last().reject(new Error('bad again') as never);
  await flush();

  registry.set(run, Atom.Reset);
  assert.equal(registry.get(run)._tag, 'Initial', 'reset()');

  registry.set(run, 'dev');
  unmount();
  await flush();
  assert.equal(runs.last().aborted, false, 'the component is gone, the write still runs');
  runs.last().resolve({
    worktreeId: 10,
    commandName: 'dev',
    summary: { name: 'dev', status: 'running', ports: [] },
  });
  await flush();
  unmount = registry.mount(run);
  unmount();
});

test('Atom.fn promiseExit mode: per-call onError equivalent', async (t) => {
  const registry = makeTestRegistry({
    retry: false,
    api: {
      reconcileWorkspace: () => Effect.succeed({ findings: [] }),
      fetchWorkspace: () => Effect.fail(new Error('the runtime dropped the read')) as never,
    },
  });
  t.after(() => registry.dispose());
  const recheck = makeRecheckProjectAtom();
  t.after(registry.mount(recheck));

  registry.set(recheck, 7);
  const exit = await Effect.runPromise(
    Effect.exit(Atom.getResult(recheck, { suspendOnWaiting: true })).pipe(
      Effect.provideService(AtomRegistry.AtomRegistry, registry),
    ),
  );

  assert.equal(Exit.isFailure(exit), true);
  assert.equal(mutationData(registry.get(recheck)), undefined, 'no verdict without a read');
});

test('a settled recheck exposes its verdict as mutation data', async (t) => {
  const registry = makeTestRegistry({
    api: {
      reconcileWorkspace: () => Effect.succeed({ findings: [] }),
      fetchWorkspace: () =>
        Effect.succeed(
          snapshotOf({ projects: [project({ id: 7, name: 'notes', kind: 'folder' })] }),
        ),
    },
  });
  t.after(() => registry.dispose());
  const recheck = makeRecheckProjectAtom();
  t.after(registry.mount(recheck));

  registry.set(recheck, 7);
  await flush();

  assert.deepEqual(mutationData(registry.get(recheck)), { status: 'restored', projectId: 7 });
});
