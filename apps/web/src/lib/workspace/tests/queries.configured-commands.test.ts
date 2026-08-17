import assert from 'node:assert/strict';
import test from 'node:test';

import type { QueryClient } from '@tanstack/react-query';
import { Effect } from 'effect';

import type { CommandActionOutput } from '@isagi/contracts';

import { runConfiguredCommandFromPalette } from '../queries.js';
import { commandLogMetadataQueryKey, worktreeCommandsQueryKey } from '../query-keys.js';

const WORKTREE_ID = 11;

test('a resolved palette run returns the endpoint output and reconciles both command caches', async () => {
  const { client, keys } = recordingClient();
  const output = actionOutput('running');

  const result = await runConfiguredCommandFromPalette(
    WORKTREE_ID,
    'dev',
    () => Effect.succeed(output),
    client,
  );

  assert.equal(result, output);
  assert.deepEqual(keys, [
    worktreeCommandsQueryKey(WORKTREE_ID),
    commandLogMetadataQueryKey(WORKTREE_ID, 'dev'),
  ]);
});

test('a success-shaped failed launch still resolves, so the caller can hand off to the drawer', async () => {
  const { client } = recordingClient();
  const output = actionOutput('failed');

  const result = await runConfiguredCommandFromPalette(
    WORKTREE_ID,
    'dev',
    () => Effect.succeed(output),
    client,
  );

  assert.equal(result.summary.status, 'failed');
});

test('a rejected palette run rethrows and still reconciles both command caches', async () => {
  const { client, keys } = recordingClient();

  await assert.rejects(
    () =>
      runConfiguredCommandFromPalette(
        WORKTREE_ID,
        'dev',
        () => Effect.fail(new Error('runtime unreachable')),
        client,
      ),
    /runtime unreachable/,
  );

  // The invalidation in `finally` must not swallow or replace the run failure:
  // the palette needs the original rejection to render its inline error.
  assert.deepEqual(keys, [
    worktreeCommandsQueryKey(WORKTREE_ID),
    commandLogMetadataQueryKey(WORKTREE_ID, 'dev'),
  ]);
});

function actionOutput(status: CommandActionOutput['summary']['status']): CommandActionOutput {
  return {
    worktreeId: WORKTREE_ID,
    commandName: 'dev',
    summary: { name: 'dev', status, ports: [] },
  };
}

function recordingClient() {
  const keys: unknown[] = [];
  const client = {
    invalidateQueries: async (input: { queryKey: unknown }) => {
      keys.push(input.queryKey);
    },
  } as unknown as QueryClient;
  return { client, keys };
}
