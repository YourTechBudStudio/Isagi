import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import { CommandError } from '../commands.service.js';
import {
  commandService,
  delay,
  fakeAttachment,
  fakeCommandLogPtyService,
  receiveMessagesUntilClose,
  withCommandsApi,
} from './test-support.js';

test('command log stream rejects well-formed client messages as read-only and closes', async () => {
  const latestRun = {
    id: 1,
    startedAt: '2026-06-19T00:00:00.000Z',
    completedAt: null,
    status: 'running' as const,
    ptyProcessId: 20,
    hasPtyProcess: true,
    diagnostic: null,
  };
  await withCommandsApi(
    commandService({
      readLogMetadata: () =>
        Effect.succeed({
          worktreeId: 10,
          commandName: 'dev',
          status: 'running',
          latestRun,
        }),
    }),
    async (fastify) => {
      const ws = await fastify.injectWS('/api/v1/worktrees/10/commands/log-stream?commandName=dev');
      const messagesPromise = receiveMessagesUntilClose(ws);
      await delay(10);
      ws.send(JSON.stringify({ type: 'input', data: 'nope' }));
      const messages = await messagesPromise;

      assert.deepEqual(messages.at(-1), {
        type: 'error',
        code: 'read_only_stream',
        message: 'Command log streams are read-only.',
      });
    },
    {
      pty: fakeCommandLogPtyService({
        attach: () => Effect.succeed(fakeAttachment({ replayBytes: 0 })),
        replay: (input) =>
          Effect.sync(() => {
            input.send({ type: 'replay_start', bytes: 0 });
            input.send({ type: 'replay_end' });
          }),
      }),
    },
  );
});

test('command log stream rejects malformed client messages with a stable protocol error', async () => {
  const latestRun = {
    id: 1,
    startedAt: '2026-06-19T00:00:00.000Z',
    completedAt: null,
    status: 'running' as const,
    ptyProcessId: 20,
    hasPtyProcess: true,
    diagnostic: null,
  };
  await withCommandsApi(
    commandService({
      readLogMetadata: () =>
        Effect.succeed({
          worktreeId: 10,
          commandName: 'dev',
          status: 'running',
          latestRun,
        }),
    }),
    async (fastify) => {
      const ws = await fastify.injectWS('/api/v1/worktrees/10/commands/log-stream?commandName=dev');
      const messagesPromise = receiveMessagesUntilClose(ws);
      await delay(10);
      ws.send('{');
      const messages = await messagesPromise;

      assert.deepEqual(messages.at(-1), { type: 'error', code: 'invalid_message' });
    },
    {
      pty: fakeCommandLogPtyService({
        attach: () => Effect.succeed(fakeAttachment({ replayBytes: 0 })),
        replay: (input) =>
          Effect.sync(() => {
            input.send({ type: 'replay_start', bytes: 0 });
            input.send({ type: 'replay_end' });
          }),
      }),
    },
  );
});

test('command log stream maps unreadable commands to stable socket errors', async () => {
  await withCommandsApi(
    commandService({
      readLogMetadata: () =>
        Effect.sleep(1).pipe(
          Effect.zipRight(
            Effect.fail(
              new CommandError({
                code: 'command_not_found',
                message: 'Command old dev was not found.',
                worktreeId: 10,
                commandName: 'old dev',
              }),
            ),
          ),
        ),
    }),
    async (fastify) => {
      const ws = await fastify.injectWS(
        '/api/v1/worktrees/10/commands/log-stream?commandName=old%20dev',
      );
      const messages = await receiveMessagesUntilClose(ws);

      assert.deepEqual(messages, [
        {
          type: 'error',
          code: 'command_not_found',
          message: 'Command old dev was not found.',
        },
      ]);
    },
  );
});
