import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Layer, ManagedRuntime } from 'effect';
import Fastify from 'fastify';

import type { WorktreeCommandsOutput } from '@isagi/contracts';

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
const idleLogs = { worktreeId: 10, commandName: 'dev', status: 'idle' as const, latestRun: null };

test('command route returns configured command reads through the contract path', async () => {
  await withCommandsApi(
    {
      listForWorktree: (worktreeId) =>
        Effect.succeed({
          status: 'configured',
          worktreeId,
          commands: [{ name: 'dev', status: 'idle', ports: [5173] }],
        }),
      readLatestLogs: () => Effect.succeed(idleLogs),
      run: () => Effect.succeed(idleAction),
      stop: () => Effect.succeed(idleAction),
      restart: () => Effect.succeed(idleAction),
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
      });
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
      readLatestLogs: () => Effect.succeed(idleLogs),
      run: () => Effect.succeed(idleAction),
      stop: () => Effect.succeed(idleAction),
      restart: () => Effect.succeed(idleAction),
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

async function withCommandsApi<A>(
  service: CommandServiceShape,
  run: (fastify: Fastify.FastifyInstance) => Promise<A>,
) {
  const fastify = Fastify({ logger: false });
  const runtime = ManagedRuntime.make(Layer.succeed(CommandService, service));
  try {
    registerCommandsApi(fastify, runtime as never);
    await fastify.ready();
    return await run(fastify);
  } finally {
    await fastify.close();
    await runtime.dispose();
  }
}
