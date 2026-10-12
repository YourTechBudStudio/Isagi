import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { Effect } from 'effect';

import type {
  CommandActionOutput,
  CommandLogMetadataOutput,
  WorktreeCommandsOutput,
} from '@isagi/contracts';

import { runApp } from '../../state/runtime.js';
import { flush, makeTestRegistry } from '../../state/testing.js';
import { runConfiguredCommandFromPalette } from '../commits.js';
import { commandLogMetadataAtom, worktreeCommandsAtom } from '../queries.js';
import { refuse } from './test-support.js';

const WORKTREE_ID = 11;

/**
 * A session whose drawer holds the catalog and the command's log metadata, with `run` as the
 * command endpoint. `reads` records each re-read of the two command read models, in order.
 */
async function commandSession(
  t: TestContext,
  run: () => Effect.Effect<CommandActionOutput, never>,
) {
  const reads: string[] = [];
  const registry = makeTestRegistry({
    retry: false,
    api: {
      runCommand: run,
      fetchWorktreeCommands: (worktreeId) =>
        Effect.sync(() => {
          reads.push(`catalog:${worktreeId}`);
          return { status: 'configured' } as unknown as WorktreeCommandsOutput;
        }),
      fetchCommandLogMetadata: (worktreeId, commandName) =>
        Effect.sync(() => {
          reads.push(`log:${worktreeId}:${commandName}`);
          return { latestRun: null } as unknown as CommandLogMetadataOutput;
        }),
    },
  });
  t.after(() => registry.dispose());
  t.after(registry.mount(worktreeCommandsAtom(WORKTREE_ID)));
  t.after(registry.mount(commandLogMetadataAtom([WORKTREE_ID, 'dev'])));
  await flush();
  reads.length = 0;
  return { registry, reads };
}

test('a resolved palette run returns the endpoint output and reconciles both command caches', async (t) => {
  const output = actionOutput('running');
  const { registry, reads } = await commandSession(t, () => Effect.succeed(output));

  const result = await runApp(registry, runConfiguredCommandFromPalette(WORKTREE_ID, 'dev'));

  assert.equal(result, output);
  assert.deepEqual(reads, [`catalog:${WORKTREE_ID}`, `log:${WORKTREE_ID}:dev`]);
});

test('a success-shaped failed launch still resolves, so the caller can hand off to the drawer', async (t) => {
  const { registry } = await commandSession(t, () => Effect.succeed(actionOutput('failed')));

  const result = await runApp(registry, runConfiguredCommandFromPalette(WORKTREE_ID, 'dev'));

  assert.equal(result.summary.status, 'failed');
});

test('a rejected palette run rethrows and still reconciles both command caches', async (t) => {
  const { registry, reads } = await commandSession(t, () => refuse('runtime unreachable'));

  await assert.rejects(
    () => runApp(registry, runConfiguredCommandFromPalette(WORKTREE_ID, 'dev')),
    /runtime unreachable/,
  );

  // The re-reads on the way out must not swallow or replace the run failure:
  // the palette needs the original rejection to render its inline error.
  assert.deepEqual(reads, [`catalog:${WORKTREE_ID}`, `log:${WORKTREE_ID}:dev`]);
});

function actionOutput(status: CommandActionOutput['summary']['status']): CommandActionOutput {
  return {
    worktreeId: WORKTREE_ID,
    commandName: 'dev',
    summary: { name: 'dev', status, ports: [] },
  };
}
