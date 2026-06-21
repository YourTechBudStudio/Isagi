import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import {
  commandLogStreamWebSocketEndpoint,
  type PtyStreamOutputMessageSet,
} from '@isagi/contracts';

import { PtyServiceError } from '../../pty-processes/index.js';
import type { PtyAttachment } from '../../pty-processes/pty.service.js';
import {
  commandService,
  delayedSucceed,
  fakeAttachment,
  fakeCommandLogPtyService,
  fakePtyProcess,
  idleLogMetadata,
  receiveMessagesUntilClose,
  waitUntil,
  withCommandsApi,
} from './test-support.js';

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
