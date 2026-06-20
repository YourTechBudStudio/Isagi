import assert from 'node:assert/strict';
import test from 'node:test';

import { QueryClient } from '@tanstack/react-query';

import { commandLogMetadataQueryKey, worktreeCommandsQueryKey } from '../query-keys.js';
import { decodeCommandLogStreamMessage, invalidateCommandReadModel } from './stream.js';

test('command log stream decoder rejects malformed protocol messages', () => {
  assert.equal(decodeCommandLogStreamMessage('{'), null);
  assert.equal(decodeCommandLogStreamMessage(JSON.stringify({ type: 'unknown' })), null);
  assert.deepEqual(decodeCommandLogStreamMessage(JSON.stringify({ type: 'replay_end' })), {
    type: 'replay_end',
  });
});

test('command log exit invalidates command read-model queries', async () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(worktreeCommandsQueryKey(10), { status: 'configured' });
  queryClient.setQueryData(commandLogMetadataQueryKey(10, 'dev'), { latestRun: null });
  queryClient.setQueryData(commandLogMetadataQueryKey(10, 'other'), { latestRun: null });

  await invalidateCommandReadModel(queryClient, 10, 'dev');

  assert.equal(queryClient.getQueryState(worktreeCommandsQueryKey(10))?.isInvalidated, true);
  assert.equal(
    queryClient.getQueryState(commandLogMetadataQueryKey(10, 'dev'))?.isInvalidated,
    true,
  );
  assert.equal(
    queryClient.getQueryState(commandLogMetadataQueryKey(10, 'other'))?.isInvalidated,
    false,
  );
});
