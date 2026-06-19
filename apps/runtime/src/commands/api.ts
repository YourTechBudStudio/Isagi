import { Effect, type ManagedRuntime } from 'effect';
import type { FastifyInstance } from 'fastify';

import { apiEndpoints, type ApiError } from '@isagi/contracts';

import { registerApiEndpoint, type ApiRouteContext, errorMessage } from '../lib/api/index.js';
import { DatabaseError } from '../persistence/index.js';
import type { RuntimeServices } from '../runtime.layer.js';
import { CommandError, CommandService } from './commands.service.js';

const runWithRuntime =
  (runtime: ManagedRuntime.ManagedRuntime<RuntimeServices, unknown>) =>
  <A>(
    effect: Effect.Effect<A, unknown, RuntimeServices>,
    options?: { readonly signal?: AbortSignal | undefined },
  ) =>
    runtime.runPromise(effect, options);

export function registerCommandsApi(
  fastify: FastifyInstance,
  runtime: ManagedRuntime.ManagedRuntime<RuntimeServices, unknown>,
) {
  const run = runWithRuntime(runtime);

  registerApiEndpoint(fastify, apiEndpoints.commands.listForWorktree, {
    handle: (_input, _context, params) =>
      Effect.gen(function* () {
        const commands = yield* CommandService;
        return yield* commands.listForWorktree(params.worktreeId);
      }),
    mapError: (error, context) => toCommandApiError(error, context),
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.commands.logs, {
    handle: (_input, _context, params, query) =>
      Effect.gen(function* () {
        const commands = yield* CommandService;
        return yield* commands.readLatestLogs({
          worktreeId: params.worktreeId,
          commandName: query.commandName,
        });
      }),
    mapError: (error, context) => toCommandApiError(error, context),
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.commands.run, {
    handle: (input, _context, params) =>
      Effect.gen(function* () {
        const commands = yield* CommandService;
        return yield* commands.run({
          worktreeId: params.worktreeId,
          commandName: input.commandName,
        });
      }),
    mapError: (error, context) => toCommandApiError(error, context),
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.commands.stop, {
    handle: (input, _context, params) =>
      Effect.gen(function* () {
        const commands = yield* CommandService;
        return yield* commands.stop({
          worktreeId: params.worktreeId,
          commandName: input.commandName,
        });
      }),
    mapError: (error, context) => toCommandApiError(error, context),
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.commands.restart, {
    handle: (input, _context, params) =>
      Effect.gen(function* () {
        const commands = yield* CommandService;
        return yield* commands.restart({
          worktreeId: params.worktreeId,
          commandName: input.commandName,
        });
      }),
    mapError: (error, context) => toCommandApiError(error, context),
    run,
  });
}

function toCommandApiError(error: unknown, context: ApiRouteContext): ApiError {
  if (error instanceof CommandError) {
    return {
      code: 'worktree_commands_rejected',
      status: 400,
      message: error.message,
      requestId: context.requestId,
      data: {
        reason: error.code,
        ...(error.worktreeId ? { worktreeId: error.worktreeId } : {}),
        ...(error.commandName ? { commandName: error.commandName } : {}),
      },
    };
  }

  if (error instanceof DatabaseError) {
    return {
      code: 'runtime_database_failed',
      status: 500,
      message: `Database operation failed: ${error.operation}`,
      requestId: context.requestId,
      data: { operation: error.operation },
    };
  }

  console.error(
    `[runtime] Unhandled command API handler error during ${context.endpointId}`,
    error,
  );

  return {
    code: 'api_unhandled_error',
    status: 500,
    message: errorMessage(error),
    requestId: context.requestId,
    data: { endpointId: context.endpointId },
  };
}
