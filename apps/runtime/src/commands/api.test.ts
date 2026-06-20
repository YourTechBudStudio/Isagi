import assert from 'node:assert/strict';
import test from 'node:test';

import websocket from '@fastify/websocket';
import { Effect, Layer, ManagedRuntime } from 'effect';
import Fastify from 'fastify';

import {
  commandLogStreamWebSocketEndpoint,
  type PtyStreamOutputMessageSet,
  type WorktreeCommandsOutput,
} from '@isagi/contracts';

import { PtyService, PtyServiceError, type PtyServiceShape } from '../pty-processes/index.js';
import type { PtyAttachment } from '../pty-processes/pty.service.js';
import { registerCommandsApi } from './api.js';
import {
  CommandError,
  CommandService,
  type CommandService as CommandServiceShape,
} from './commands.service.js';

const idleAction = {
  worktreeId: 10,
  commandName: 'dev',
  summary: { name: 'dev', status: 'idle' as const, ports: [] },
};
const idleLogMetadata = {
  worktreeId: 10,
  commandName: 'dev',
  status: 'idle' as const,
  latestRun: null,
};

test('command route returns configured command reads through the contract path', async () => {
  await withCommandsApi(
    {
      listForWorktree: (worktreeId) =>
        Effect.succeed({
          status: 'configured',
          worktreeId,
          commands: [{ name: 'dev', status: 'idle', ports: [5173] }],
          removedCommands: [],
        }),
      readLogMetadata: () => Effect.succeed(idleLogMetadata),
      run: () => Effect.succeed(idleAction),
      stop: () => Effect.succeed(idleAction),
      restart: () => Effect.succeed(idleAction),
      runPostCreateLifecycle: () => Effect.void,
      cleanupBeforeWorktreeDelete: () => Effect.void,
      cleanupBeforeWorktreePrune: () => Effect.void,
      reconcileStaleRunningCommands: Effect.void,
    },
    async (fastify) => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/api/v1/worktrees/10/commands',
      });
      const payload = response.json() as { data?: WorktreeCommandsOutput };

      assert.equal(response.statusCode, 200);
      assert.deepEqual(payload.data, {
        status: 'configured',
        worktreeId: 10,
        commands: [{ name: 'dev', status: 'idle', ports: [5173] }],
        removedCommands: [],
      });
    },
  );
});

test('command route returns command log metadata through the contract path', async () => {
  await withCommandsApi(
    {
      listForWorktree: (worktreeId) =>
        Effect.succeed({
          status: 'configured',
          worktreeId,
          commands: [{ name: 'dev', status: 'failed', ports: [] }],
          removedCommands: [],
        }),
      readLogMetadata: () =>
        Effect.succeed({
          worktreeId: 10,
          commandName: 'dev',
          status: 'failed',
          latestRun: {
            id: 1,
            startedAt: '2026-06-19T00:00:00.000Z',
            completedAt: '2026-06-19T00:00:01.000Z',
            status: 'failed',
            ptyProcessId: null,
            hasPtyProcess: false,
            diagnostic: {
              reason: 'missing_cwd',
              detail: 'missing-dir',
            },
          },
        }),
      run: () => Effect.succeed(idleAction),
      stop: () => Effect.succeed(idleAction),
      restart: () => Effect.succeed(idleAction),
      runPostCreateLifecycle: () => Effect.void,
      cleanupBeforeWorktreeDelete: () => Effect.void,
      cleanupBeforeWorktreePrune: () => Effect.void,
      reconcileStaleRunningCommands: Effect.void,
    },
    async (fastify) => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/api/v1/worktrees/10/commands/log-metadata?commandName=dev',
      });
      const payload = response.json() as {
        data?: { readonly latestRun?: { readonly diagnostic?: { readonly reason?: string } } };
      };

      assert.equal(response.statusCode, 200);
      assert.equal(payload.data?.latestRun?.diagnostic?.reason, 'missing_cwd');
    },
  );
});

test('command log stream contract uses the command-owned websocket path', () => {
  assert.equal(
    commandLogStreamWebSocketEndpoint.path,
    '/worktrees/:worktreeId/commands/log-stream',
  );
});

test('command log stream sends no-run state and closes cleanly', async () => {
  await withCommandsApi(
    commandService({ readLogMetadata: () => delayedSucceed(idleLogMetadata) }),
    async (fastify) => {
      const ws = await fastify.injectWS('/api/v1/worktrees/10/commands/log-stream?commandName=dev');
      const messages = await receiveMessagesUntilClose(ws);

      assert.deepEqual(messages, [
        {
          type: 'command_log_state',
          worktreeId: 10,
          commandName: 'dev',
          status: 'idle',
          latestRun: null,
          live: false,
        },
      ]);
    },
  );
});

test('command log stream sends pre-PTY diagnostics without replaying output', async () => {
  const latestRun = {
    id: 2,
    startedAt: '2026-06-19T00:00:00.000Z',
    completedAt: '2026-06-19T00:00:01.000Z',
    status: 'failed' as const,
    ptyProcessId: null,
    hasPtyProcess: false,
    diagnostic: {
      reason: 'missing_cwd' as const,
      detail: 'apps/missing',
    },
  };

  await withCommandsApi(
    commandService({
      readLogMetadata: () =>
        delayedSucceed({
          worktreeId: 10,
          commandName: 'dev',
          status: 'failed',
          latestRun,
        }),
    }),
    async (fastify) => {
      const ws = await fastify.injectWS('/api/v1/worktrees/10/commands/log-stream?commandName=dev');
      const messages = await receiveMessagesUntilClose(ws);

      assert.deepEqual(messages, [
        {
          type: 'command_log_state',
          worktreeId: 10,
          commandName: 'dev',
          status: 'failed',
          latestRun,
          live: false,
        },
      ]);
    },
    {
      pty: fakeCommandLogPtyService({
        getAttachmentPlan: () => Effect.die('pre-PTY diagnostics must not resolve a PTY plan'),
        replay: () => Effect.die('pre-PTY diagnostics must not replay terminal output'),
      }),
    },
  );
});

test('command log stream attaches first, replays output, and buffers live output during replay', async () => {
  let liveSend: ((message: PtyStreamOutputMessageSet) => void) | null = null;
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
        delayedSucceed({
          worktreeId: 10,
          commandName: 'dev',
          status: 'running',
          latestRun,
        }),
    }),
    async (fastify) => {
      const ws = await fastify.injectWS('/api/v1/worktrees/10/commands/log-stream?commandName=dev');
      const messagesPromise = receiveMessagesUntilClose(ws);
      const messages = await messagesPromise;

      assert.deepEqual(messages, [
        {
          type: 'command_log_state',
          worktreeId: 10,
          commandName: 'dev',
          status: 'running',
          latestRun,
          live: true,
        },
        { type: 'replay_start', bytes: 4 },
        { type: 'output', data: 'old\n', replay: true },
        { type: 'replay_end' },
        { type: 'output', data: 'live\n' },
        { type: 'exit', exitCode: 0, signal: null },
      ]);
    },
    {
      pty: fakeCommandLogPtyService({
        attach: (input) =>
          Effect.sync(() => {
            liveSend = input.send;
            return fakeAttachment({ replayBytes: 4 });
          }),
        replay: (input) =>
          Effect.sync(() => {
            input.send({ type: 'replay_start', bytes: 4 });
            liveSend?.({ type: 'output', data: 'live\n' });
            input.send({ type: 'output', data: 'old\n', replay: true });
            input.send({ type: 'replay_end' });
            liveSend?.({ type: 'exit', exitCode: 0, signal: null });
          }),
      }),
    },
  );
});

test('command log stream replays to the attach cursor without a gap or duplicate', async () => {
  let liveSend: ((message: PtyStreamOutputMessageSet) => void) | null = null;
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
        delayedSucceed({
          worktreeId: 10,
          commandName: 'dev',
          status: 'running',
          latestRun,
        }),
    }),
    async (fastify) => {
      const ws = await fastify.injectWS('/api/v1/worktrees/10/commands/log-stream?commandName=dev');
      const messages = await receiveMessagesUntilClose(ws);

      assert.deepEqual(messages, [
        {
          type: 'command_log_state',
          worktreeId: 10,
          commandName: 'dev',
          status: 'running',
          latestRun,
          live: true,
        },
        { type: 'replay_start', bytes: 9 },
        { type: 'output', data: 'old\ngap\n', replay: true },
        { type: 'replay_end' },
        { type: 'exit', exitCode: 0, signal: null },
      ]);
    },
    {
      pty: fakeCommandLogPtyService({
        getAttachmentPlan: () =>
          Effect.succeed({
            session: fakePtyProcess(),
            replayBytes: 4,
            live: true,
            replaySource: 'file_log',
          }),
        attach: (input) =>
          Effect.sync(() => {
            liveSend = input.send;
            return fakeAttachment({ replayBytes: 9 });
          }),
        replay: (input) =>
          Effect.sync(() => {
            input.send({ type: 'replay_start', bytes: input.bytes ?? 0 });
            input.send({ type: 'output', data: 'old\ngap\n', replay: true });
            input.send({ type: 'replay_end' });
            liveSend?.({ type: 'exit', exitCode: 0, signal: null });
          }),
      }),
    },
  );
});

test('command log stream falls back to replay-only output after stale live attach failure', async () => {
  let metadataReads = 0;
  let planReads = 0;
  const runningRun = {
    id: 1,
    startedAt: '2026-06-19T00:00:00.000Z',
    completedAt: null,
    status: 'running' as const,
    ptyProcessId: 20,
    hasPtyProcess: true,
    diagnostic: null,
  };
  const failedRun = {
    id: 1,
    startedAt: '2026-06-19T00:00:00.000Z',
    completedAt: '2026-06-19T00:00:01.000Z',
    status: 'failed' as const,
    ptyProcessId: 20,
    hasPtyProcess: true,
    diagnostic: null,
  };

  await withCommandsApi(
    commandService({
      readLogMetadata: () =>
        Effect.succeed(
          metadataReads++ === 0
            ? {
                worktreeId: 10,
                commandName: 'dev',
                status: 'running',
                latestRun: runningRun,
              }
            : {
                worktreeId: 10,
                commandName: 'dev',
                status: 'failed',
                latestRun: failedRun,
              },
        ),
    }),
    async (fastify) => {
      const ws = await fastify.injectWS('/api/v1/worktrees/10/commands/log-stream?commandName=dev');
      const messages = await receiveMessagesUntilClose(ws);

      assert.deepEqual(messages, [
        {
          type: 'command_log_state',
          worktreeId: 10,
          commandName: 'dev',
          status: 'running',
          latestRun: runningRun,
          live: true,
        },
        {
          type: 'command_log_state',
          worktreeId: 10,
          commandName: 'dev',
          status: 'failed',
          latestRun: failedRun,
          live: false,
        },
        { type: 'replay_start', bytes: 12 },
        { type: 'output', data: 'final log\n', replay: true },
        { type: 'replay_end' },
      ]);
    },
    {
      pty: fakeCommandLogPtyService({
        getAttachmentPlan: () =>
          Effect.succeed(
            planReads++ === 0
              ? {
                  session: fakePtyProcess(),
                  replayBytes: 4,
                  live: true,
                  replaySource: 'file_log',
                }
              : {
                  session: fakePtyProcess({ status: 'failed' }),
                  replayBytes: 12,
                  live: false,
                  replaySource: 'file_log',
                },
          ),
        attach: () =>
          Effect.fail(
            new PtyServiceError({
              code: 'backend_attach_failed',
              message: 'Could not attach to PTY process 20.',
              ptyProcessId: 20,
            }),
          ),
        replay: (input) =>
          Effect.sync(() => {
            input.send({ type: 'replay_start', bytes: input.bytes ?? 0 });
            input.send({ type: 'output', data: 'final log\n', replay: true });
            input.send({ type: 'replay_end' });
          }),
      }),
    },
  );
});

test('command log stream replays an exited command without taking a live attachment', async () => {
  const latestRun = {
    id: 1,
    startedAt: '2026-06-19T00:00:00.000Z',
    completedAt: '2026-06-19T00:00:01.000Z',
    status: 'exited' as const,
    ptyProcessId: 20,
    hasPtyProcess: true,
    diagnostic: null,
  };

  await withCommandsApi(
    commandService({
      readLogMetadata: () =>
        delayedSucceed({
          worktreeId: 10,
          commandName: 'dev',
          status: 'exited',
          latestRun,
        }),
    }),
    async (fastify) => {
      const ws = await fastify.injectWS('/api/v1/worktrees/10/commands/log-stream?commandName=dev');
      const messages = await receiveMessagesUntilClose(ws);

      assert.deepEqual(messages, [
        {
          type: 'command_log_state',
          worktreeId: 10,
          commandName: 'dev',
          status: 'exited',
          latestRun,
          live: false,
        },
        { type: 'replay_start', bytes: 12 },
        { type: 'output', data: 'completed\nlog', replay: true },
        { type: 'replay_end' },
      ]);
    },
    {
      pty: fakeCommandLogPtyService({
        getAttachmentPlan: () =>
          Effect.succeed({
            session: fakePtyProcess({ status: 'exited' }),
            replayBytes: 12,
            live: false,
            replaySource: 'file_log',
          }),
        attach: () => Effect.die('exited command logs must not attach'),
        replay: (input) =>
          Effect.sync(() => {
            input.send({ type: 'replay_start', bytes: input.bytes ?? 0 });
            input.send({ type: 'output', data: 'completed\nlog', replay: true });
            input.send({ type: 'replay_end' });
          }),
      }),
    },
  );
});

test('command log stream preserves replay-before-attach for null-cursor live backends', async () => {
  const events: string[] = [];
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
      const messages = await receiveMessagesUntilClose(ws);

      assert.deepEqual(events, ['replay', 'attach']);
      assert.deepEqual(messages, [
        {
          type: 'command_log_state',
          worktreeId: 10,
          commandName: 'dev',
          status: 'running',
          latestRun,
          live: true,
        },
        { type: 'replay_start', bytes: 0 },
        { type: 'replay_end' },
        { type: 'exit', exitCode: 0, signal: null },
      ]);
    },
    {
      pty: fakeCommandLogPtyService({
        getAttachmentPlan: () =>
          Effect.succeed({
            session: fakePtyProcess({ backend: 'tmux', logMode: 'none' }),
            replayBytes: null,
            live: true,
            replaySource: 'backend',
          }),
        attach: (input) =>
          Effect.sync(() => {
            events.push('attach');
            input.send({ type: 'exit', exitCode: 0, signal: null });
            return fakeAttachment({ replayBytes: null });
          }),
        replay: (input) =>
          Effect.sync(() => {
            events.push('replay');
            input.send({ type: 'replay_start', bytes: 0 });
            input.send({ type: 'replay_end' });
          }),
      }),
    },
  );
});

test('command log stream supersedes a live viewer before replacement attach', async () => {
  let active: {
    readonly send: (message: PtyStreamOutputMessageSet) => void;
    readonly displace: (attachment: PtyAttachment) => Effect.Effect<void, never> | undefined;
  } | null = null;
  let attachCalls = 0;
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
        delayedSucceed({
          worktreeId: 10,
          commandName: 'dev',
          status: 'running',
          latestRun,
        }),
    }),
    async (fastify) => {
      const first = await fastify.injectWS(
        '/api/v1/worktrees/10/commands/log-stream?commandName=dev',
      );
      const firstMessagesPromise = receiveMessagesUntilClose(first);
      await waitUntil(() => attachCalls === 1, 'first command-log attachment');

      const second = await fastify.injectWS(
        '/api/v1/worktrees/10/commands/log-stream?commandName=dev',
      );
      const secondMessagesPromise = receiveMessagesUntilClose(second);

      const firstMessages = await firstMessagesPromise;
      assert.deepEqual(firstMessages.at(-1), { type: 'error', code: 'stream_superseded' });
      await waitUntil(() => attachCalls === 2, 'replacement command-log attachment');

      active?.send({ type: 'exit', exitCode: 0, signal: null });
      const secondMessages = await secondMessagesPromise;
      assert.equal(
        secondMessages.some(
          (message) =>
            typeof message === 'object' &&
            message !== null &&
            'type' in message &&
            message.type === 'error',
        ),
        false,
      );
      assert.deepEqual(secondMessages.at(-1), { type: 'exit', exitCode: 0, signal: null });
    },
    {
      pty: fakeCommandLogPtyService({
        attach: (input) =>
          Effect.gen(function* () {
            if (active) {
              if (!input.supersede || !input.displace) {
                return yield* Effect.fail(
                  new PtyServiceError({
                    code: 'session_already_attached',
                    message: 'PTY process is already attached.',
                    ptyProcessId: input.ptyProcessId,
                  }),
                );
              }
              const displacement = active.displace(fakeAttachment());
              if (displacement) yield* displacement;
            }
            attachCalls += 1;
            active = {
              send: input.send,
              displace: input.displace ?? (() => undefined),
            };
            return fakeAttachment({
              replayBytes: 0,
              detach: Effect.sync(() => {
                active = null;
              }),
            });
          }),
        replay: (input) =>
          Effect.sync(() => {
            input.send({ type: 'replay_start', bytes: input.bytes ?? 0 });
            input.send({ type: 'replay_end' });
          }),
      }),
    },
  );
});

test('command log stream replays exited command logs independently for multiple viewers', async () => {
  let replayCalls = 0;
  const latestRun = {
    id: 1,
    startedAt: '2026-06-19T00:00:00.000Z',
    completedAt: '2026-06-19T00:00:01.000Z',
    status: 'exited' as const,
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
          status: 'exited',
          latestRun,
        }),
    }),
    async (fastify) => {
      const first = await fastify.injectWS(
        '/api/v1/worktrees/10/commands/log-stream?commandName=dev',
      );
      const second = await fastify.injectWS(
        '/api/v1/worktrees/10/commands/log-stream?commandName=dev',
      );

      const [firstMessages, secondMessages] = await Promise.all([
        receiveMessagesUntilClose(first),
        receiveMessagesUntilClose(second),
      ]);

      assert.equal(replayCalls, 2);
      assert.deepEqual(firstMessages.at(-2), { type: 'output', data: 'done\n', replay: true });
      assert.deepEqual(secondMessages.at(-2), { type: 'output', data: 'done\n', replay: true });
    },
    {
      pty: fakeCommandLogPtyService({
        getAttachmentPlan: () =>
          Effect.succeed({
            session: fakePtyProcess({ status: 'exited' }),
            replayBytes: 5,
            live: false,
            replaySource: 'file_log',
          }),
        attach: () => Effect.die('exited command logs must not attach'),
        replay: (input) =>
          Effect.sync(() => {
            replayCalls += 1;
            input.send({ type: 'replay_start', bytes: input.bytes ?? 0 });
            input.send({ type: 'output', data: 'done\n', replay: true });
            input.send({ type: 'replay_end' });
          }),
      }),
    },
  );
});

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

test('command route maps missing worktree to command rejection envelope', async () => {
  await withCommandsApi(
    {
      listForWorktree: (worktreeId) =>
        Effect.fail(
          new CommandError({
            code: 'worktree_not_found',
            message: `Worktree ${worktreeId} was not found.`,
            worktreeId,
          }),
        ),
      readLogMetadata: () => Effect.succeed(idleLogMetadata),
      run: () => Effect.succeed(idleAction),
      stop: () => Effect.succeed(idleAction),
      restart: () => Effect.succeed(idleAction),
      runPostCreateLifecycle: () => Effect.void,
      cleanupBeforeWorktreeDelete: () => Effect.void,
      cleanupBeforeWorktreePrune: () => Effect.void,
      reconcileStaleRunningCommands: Effect.void,
    },
    async (fastify) => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/api/v1/worktrees/10/commands',
      });
      const payload = response.json() as {
        error?: { readonly code?: string; readonly data?: unknown; readonly requestId?: unknown };
      };

      assert.equal(response.statusCode, 400);
      assert.equal(payload.error?.code, 'worktree_commands_rejected');
      assert.equal(typeof payload.error?.requestId, 'string');
      assert.deepEqual(payload.error?.data, {
        reason: 'worktree_not_found',
        worktreeId: 10,
      });
    },
  );
});

test('command route maps a failed termination to a degraded-runtime 500 envelope', async () => {
  await withCommandsApi(
    {
      listForWorktree: (worktreeId) =>
        Effect.succeed({ status: 'configured', worktreeId, commands: [], removedCommands: [] }),
      readLogMetadata: () => Effect.succeed(idleLogMetadata),
      run: () => Effect.succeed(idleAction),
      stop: (input) =>
        Effect.fail(
          new CommandError({
            code: 'command_action_failed',
            message: `Could not stop command ${input.commandName}.`,
            worktreeId: input.worktreeId,
            commandName: input.commandName,
          }),
        ),
      restart: () => Effect.succeed(idleAction),
      runPostCreateLifecycle: () => Effect.void,
      cleanupBeforeWorktreeDelete: () => Effect.void,
      cleanupBeforeWorktreePrune: () => Effect.void,
      reconcileStaleRunningCommands: Effect.void,
    },
    async (fastify) => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/worktrees/10/commands/stop',
        payload: { commandName: 'dev' },
      });
      const payload = response.json() as {
        error?: { readonly code?: string; readonly status?: number; readonly data?: unknown };
      };

      assert.equal(response.statusCode, 500);
      assert.equal(payload.error?.code, 'worktree_commands_rejected');
      assert.equal(payload.error?.status, 500);
      assert.deepEqual(payload.error?.data, {
        reason: 'command_action_failed',
        worktreeId: 10,
        commandName: 'dev',
      });
    },
  );
});

async function withCommandsApi<A>(
  service: CommandServiceShape,
  run: (fastify: Fastify.FastifyInstance) => Promise<A>,
  options: { readonly pty?: PtyServiceShape | undefined } = {},
) {
  const fastify = Fastify({ logger: false });
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(CommandService, service),
      Layer.succeed(PtyService, options.pty ?? fakeCommandLogPtyService()),
    ),
  );
  try {
    await fastify.register(websocket);
    registerCommandsApi(fastify, runtime as never);
    await fastify.ready();
    return await run(fastify);
  } finally {
    await fastify.close();
    await runtime.dispose();
  }
}

function commandService(overrides: Partial<CommandServiceShape> = {}): CommandServiceShape {
  return {
    listForWorktree: (worktreeId) =>
      Effect.succeed({ status: 'configured', worktreeId, commands: [], removedCommands: [] }),
    readLogMetadata: () => Effect.succeed(idleLogMetadata),
    run: () => Effect.succeed(idleAction),
    stop: () => Effect.succeed(idleAction),
    restart: () => Effect.succeed(idleAction),
    runPostCreateLifecycle: () => Effect.void,
    cleanupBeforeWorktreeDelete: () => Effect.void,
    cleanupBeforeWorktreePrune: () => Effect.void,
    reconcileStaleRunningCommands: Effect.void,
    ...overrides,
  };
}

function delayedSucceed<A>(value: A) {
  return Effect.sleep(1).pipe(Effect.as(value));
}

function fakeCommandLogPtyService(overrides: Partial<PtyServiceShape> = {}): PtyServiceShape {
  return {
    launch: () => Effect.die('launch is not used'),
    getAttachmentPlan: () =>
      Effect.succeed({
        session: fakePtyProcess(),
        replayBytes: 0,
        live: true,
        replaySource: 'file_log',
      }),
    attach: () => Effect.die('attach is not used'),
    replay: () => Effect.void,
    write: () => Effect.die('write is not used'),
    resize: () => Effect.die('resize is not used'),
    kill: () => Effect.die('kill is not used'),
    terminate: () => Effect.die('terminate is not used'),
    ...overrides,
  };
}

function fakeAttachment(overrides: Partial<PtyAttachment> = {}): PtyAttachment {
  return {
    session: fakePtyProcess(),
    attachmentId: null,
    replayBytes: 0,
    live: true,
    detach: Effect.void,
    unsubscribe: () => {},
    ...overrides,
  };
}

function fakePtyProcess(
  overrides: Partial<Parameters<PtyServiceShape['replay']>[0]['session']> = {},
): Parameters<PtyServiceShape['replay']>[0]['session'] {
  return {
    id: 20,
    paneId: 1,
    surfaceId: 2,
    worktreeId: 10,
    backend: 'node_pty',
    backendRefJson: JSON.stringify({
      schemaVersion: 1,
      backend: 'node_pty',
      ptyProcessId: 20,
      pid: 1234,
    }),
    command: 'bash',
    args: [],
    argsJson: '[]',
    cwd: '/repo/isagi',
    status: 'running',
    statusReason: null,
    exitCode: null,
    signal: null,
    logMode: 'backend_file',
    logPath: null,
    createdAt: '2026-06-19T00:00:00.000Z',
    updatedAt: '2026-06-19T00:00:00.000Z',
    exitedAt: null,
    lastSeenAt: null,
    ...overrides,
  };
}

function receiveMessagesUntilClose(ws: {
  readonly on: (event: 'message' | 'close', listener: (data: Buffer) => void) => void;
}) {
  return new Promise<unknown[]>((resolve) => {
    const messages: unknown[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    ws.on('close', () => resolve(messages));
  });
}

async function waitUntil(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
