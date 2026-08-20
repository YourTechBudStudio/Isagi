import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import { type WorktreeCommandsOutput } from '@isagi/contracts';

import { DatabaseError } from '../../persistence/index.js';
import { CommandError } from '../commands.errors.js';
import { idleAction, idleLogMetadata, withCommandsApi } from './test-support.js';

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

test('command routes carry a suspended command through the unchanged contract shapes', async () => {
  await withCommandsApi(
    {
      listForWorktree: (worktreeId) =>
        Effect.succeed({
          status: 'configured',
          worktreeId,
          commands: [{ name: 'dev', status: 'suspended', ports: [] }],
          // A removed command can hold resume intent too, and stays visible.
          removedCommands: [{ name: 'old dev', status: 'suspended', ports: [] }],
        }),
      readLogMetadata: () => Effect.succeed({ ...idleLogMetadata, status: 'suspended' as const }),
      run: () => Effect.succeed(idleAction),
      stop: () =>
        Effect.succeed({
          worktreeId: 10,
          commandName: 'dev',
          summary: { name: 'dev', status: 'suspended' as const, ports: [] },
        }),
      restart: () => Effect.succeed(idleAction),
      runPostCreateLifecycle: () => Effect.void,
      cleanupBeforeWorktreeDelete: () => Effect.void,
      cleanupBeforeWorktreePrune: () => Effect.void,
      reconcileStaleRunningCommands: Effect.void,
    },
    async (fastify) => {
      const read = await fastify.inject({ method: 'GET', url: '/api/v1/worktrees/10/commands' });
      const readPayload = read.json() as { data?: WorktreeCommandsOutput };
      assert.equal(read.statusCode, 200);
      assert.deepEqual(readPayload.data, {
        status: 'configured',
        worktreeId: 10,
        commands: [{ name: 'dev', status: 'suspended', ports: [] }],
        removedCommands: [{ name: 'old dev', status: 'suspended', ports: [] }],
      });

      const metadata = await fastify.inject({
        method: 'GET',
        url: '/api/v1/worktrees/10/commands/log-metadata?commandName=dev',
      });
      assert.equal(metadata.statusCode, 200);
      assert.equal((metadata.json() as { data?: { status?: string } }).data?.status, 'suspended');

      const stopped = await fastify.inject({
        method: 'POST',
        url: '/api/v1/worktrees/10/commands/stop',
        payload: { commandName: 'dev' },
      });
      assert.equal(stopped.statusCode, 200);
      assert.equal(
        (stopped.json() as { data?: { summary?: { status?: string } } }).data?.summary?.status,
        'suspended',
      );
    },
  );
});

test('command route reports a failed diagnostic repair as a database failure', async () => {
  // The double-fault path: the stop could not be performed *and* its diagnostic
  // could not be recorded. The database failure is what reaches the client, so
  // the route must classify it as one rather than as a rejected command action.
  await withCommandsApi(
    {
      listForWorktree: (worktreeId) =>
        Effect.succeed({
          status: 'configured',
          worktreeId,
          commands: [],
          removedCommands: [],
        }),
      readLogMetadata: () => Effect.succeed(idleLogMetadata),
      run: () => Effect.succeed(idleAction),
      stop: () =>
        Effect.fail(
          new DatabaseError({
            operation: 'readopt_worktree_command_incarnation',
            cause: new Error('transaction failed'),
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
        error?: {
          readonly code?: string;
          readonly status?: number;
          readonly data?: { readonly operation?: string };
        };
      };

      assert.equal(response.statusCode, 500);
      assert.equal(payload.error?.code, 'runtime_database_failed');
      assert.equal(payload.error?.data?.operation, 'readopt_worktree_command_incarnation');
    },
  );
});
