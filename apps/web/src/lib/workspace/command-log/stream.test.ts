import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Schema } from 'effect';

import {
  ptyWebSocketOutputMessageSchema,
  type CommandLogMetadataOutput,
  type WorktreeCommandsOutput,
} from '@isagi/contracts';

import { flush, makeTestRegistry } from '../../state/testing.js';
import { commandLogMetadataAtom, worktreeCommandsAtom } from '../queries.js';
import { decodeCommandLogStreamMessage, invalidateCommandReadModel } from './stream.js';

test('command log stream decoder rejects malformed protocol messages', () => {
  assert.equal(decodeCommandLogStreamMessage('{'), null);
  assert.equal(decodeCommandLogStreamMessage(JSON.stringify({ type: 'unknown' })), null);
  assert.deepEqual(decodeCommandLogStreamMessage(JSON.stringify({ type: 'replay_end' })), {
    type: 'replay_end',
  });
});

test('command log stream decoder keeps command errors out of pane-session errors', () => {
  assert.deepEqual(
    decodeCommandLogStreamMessage(JSON.stringify({ type: 'error', code: 'command_not_found' })),
    { type: 'error', code: 'command_not_found' },
  );
  assert.equal(
    decodeCommandLogStreamMessage(JSON.stringify({ type: 'error', code: 'attach_token_missing' })),
    null,
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(ptyWebSocketOutputMessageSchema)({
      type: 'error',
      code: 'command_not_found',
    }),
  );
});

test('command log exit invalidates command read-model queries', async (t) => {
  const catalogReads: number[] = [];
  const metadataReads: string[] = [];
  const registry = makeTestRegistry({
    api: {
      fetchWorktreeCommands: (worktreeId) =>
        Effect.sync(() => {
          catalogReads.push(worktreeId);
          return { status: 'configured' } as unknown as WorktreeCommandsOutput;
        }),
      fetchCommandLogMetadata: (_worktreeId, commandName) =>
        Effect.sync(() => {
          metadataReads.push(commandName);
          return { latestRun: null } as unknown as CommandLogMetadataOutput;
        }),
    },
  });
  t.after(() => registry.dispose());
  const unmount = [
    registry.mount(worktreeCommandsAtom(10)),
    registry.mount(commandLogMetadataAtom([10, 'dev'])),
    registry.mount(commandLogMetadataAtom([10, 'other'])),
  ];
  t.after(() => unmount.forEach((release) => release()));
  await flush();
  assert.deepEqual(catalogReads, [10]);
  assert.deepEqual(metadataReads.toSorted(), ['dev', 'other']);

  invalidateCommandReadModel(registry, 10, 'dev');
  await flush();

  // The catalog and the finished command's metadata are re-read; the other command's are not.
  assert.deepEqual(catalogReads, [10, 10]);
  assert.deepEqual(metadataReads.toSorted(), ['dev', 'dev', 'other']);
});
