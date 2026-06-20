import { Data, Effect, Schema, type ManagedRuntime } from 'effect';
import type { FastifyInstance } from 'fastify';

import {
  apiEndpoints,
  commandLogStreamWebSocketEndpoint,
  ptyWebSocketInputMessageSchema,
  type ApiError,
  type CommandLogStreamErrorCode,
  type CommandLogStreamOutputMessage,
} from '@isagi/contracts';

import { registerApiEndpoint, type ApiRouteContext, errorMessage } from '../lib/api/index.js';
import { DatabaseError } from '../persistence/index.js';
import { PtyServiceError } from '../pty-processes/index.js';
import { registerPtyStreamRoute, type PtyStreamStrategy } from '../pty-processes/stream-route.js';
import type { RuntimeServices } from '../runtime.layer.js';
import { CommandError, CommandService } from './commands.service.js';

const runWithRuntime =
  (runtime: ManagedRuntime.ManagedRuntime<RuntimeServices, unknown>) =>
  <A>(
    effect: Effect.Effect<A, unknown, RuntimeServices>,
    options?: { readonly signal?: AbortSignal | undefined },
  ) =>
    runtime.runPromise(effect, options);

class CommandLogStreamProtocolError extends Data.TaggedError('CommandLogStreamProtocolError')<{
  readonly code: 'command_not_found' | 'read_only_stream';
  readonly message: string;
}> {}

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

  registerApiEndpoint(fastify, apiEndpoints.commands.logMetadata, {
    handle: (_input, _context, params, query) =>
      Effect.gen(function* () {
        const commands = yield* CommandService;
        return yield* commands.readLogMetadata({
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

  registerCommandLogStreamRoute(fastify, run);
}

function registerCommandLogStreamRoute(
  fastify: FastifyInstance,
  run: ReturnType<typeof runWithRuntime>,
) {
  const strategy: PtyStreamStrategy<
    {
      readonly metadata: Extract<
        CommandLogStreamOutputMessage,
        { readonly type: 'command_log_state' }
      >;
    },
    Extract<CommandLogStreamOutputMessage, { readonly type: 'command_log_state' }>
  > = {
    path: commandLogStreamWebSocketEndpoint.path,
    logLabel: 'Command log stream',
    mode: 'read_only',
    closeOnExit: true,
    closeOnReplayOnly: true,
    closeOnClientError: true,
    resolveTarget: (request) =>
      Effect.gen(function* () {
        const worktreeId = decodeWorktreeId(request.params);
        const commandName = decodeCommandName(request.query);
        if (worktreeId === null || commandName === null) {
          return yield* Effect.fail(
            new CommandLogStreamProtocolError({
              code: 'command_not_found',
              message: 'Command log stream target was invalid.',
            }),
          );
        }
        const commands = yield* CommandService;
        const metadata = yield* commands.readLogMetadata({ worktreeId, commandName });
        return {
          metadata: {
            type: 'command_log_state' as const,
            worktreeId: metadata.worktreeId,
            commandName: metadata.commandName,
            status: metadata.status,
            latestRun: metadata.latestRun,
            live: false,
          },
          ptyProcessId: metadata.latestRun?.ptyProcessId ?? null,
        };
      }),
    preamble: ({ target, plan }) => ({
      ...target.metadata,
      live: Boolean(plan?.live),
    }),
    decodeClientMessage,
    handleClientMessage: () =>
      Effect.fail(
        new CommandLogStreamProtocolError({
          code: 'read_only_stream',
          message: 'Command log streams are read-only.',
        }),
      ),
    beforeAttach: () => Effect.void,
    recoverAttachFailure: ({ target, cause }) =>
      Effect.gen(function* () {
        if (!(cause instanceof PtyServiceError) || cause.code !== 'backend_attach_failed')
          return null;

        const commands = yield* CommandService;
        const metadata = yield* commands.readLogMetadata({
          worktreeId: target.metadata.worktreeId,
          commandName: target.metadata.commandName,
        });
        return {
          metadata: {
            type: 'command_log_state' as const,
            worktreeId: metadata.worktreeId,
            commandName: metadata.commandName,
            status: metadata.status,
            latestRun: metadata.latestRun,
            live: false,
          },
          ptyProcessId: metadata.latestRun?.ptyProcessId ?? null,
        };
      }),
    supersede: () => true,
    displace: ({ controls }) =>
      Effect.gen(function* () {
        controls.send({ type: 'error', code: 'stream_superseded' });
        yield* controls.detach;
        controls.close();
        yield* Effect.promise<void>(() => new Promise((resolve) => setImmediate(resolve)));
      }),
    registerAttachment: () => Effect.succeed(() => {}),
    mapError: commandLogStreamError,
  };

  registerPtyStreamRoute(fastify, run, strategy);
}

function toCommandApiError(error: unknown, context: ApiRouteContext): ApiError {
  if (error instanceof CommandError) {
    // `command_action_failed` is an operational failure (a PTY termination that
    // did not go through), not a request the caller can fix — surface it as a
    // degraded-runtime 500 so it reads differently from validation/not-found.
    const status = error.code === 'command_action_failed' ? 500 : 400;
    return {
      code: 'worktree_commands_rejected',
      status,
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

function decodeWorktreeId(params: unknown) {
  if (!params || typeof params !== 'object' || !('worktreeId' in params)) return null;
  const value = (params as Record<string, unknown>).worktreeId;
  const decoded = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof decoded === 'number' && Number.isInteger(decoded) && decoded > 0 ? decoded : null;
}

function decodeCommandName(query: unknown) {
  if (!query || typeof query !== 'object' || !('commandName' in query)) return null;
  const value = (query as Record<string, unknown>).commandName;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function decodeClientMessage(raw: string) {
  try {
    return Schema.decodeUnknownSync(ptyWebSocketInputMessageSchema)(JSON.parse(raw));
  } catch {
    return null;
  }
}

function commandLogStreamError(error: unknown): {
  readonly code: CommandLogStreamErrorCode;
  readonly message?: string;
} {
  if (error instanceof CommandLogStreamProtocolError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof CommandError) {
    if (
      error.code === 'worktree_not_found' ||
      error.code === 'command_config_invalid' ||
      error.code === 'command_not_found'
    ) {
      return { code: error.code, message: error.message };
    }
    return { code: 'unknown', message: error.message };
  }
  if (error instanceof PtyServiceError) {
    switch (error.code) {
      case 'backend_unavailable':
      case 'backend_session_missing':
      case 'backend_attach_failed':
      case 'log_read_failed':
        return { code: error.code, message: error.message };
      case 'session_not_found':
      case 'session_not_running':
      case 'active_process_missing':
      case 'active_process_not_running':
      case 'session_already_attached':
        return { code: 'backend_attach_failed', message: error.message };
    }
  }
  if (error instanceof DatabaseError)
    return {
      code: 'pty_state_load_failed',
      message: `PTY state load failed: ${error.operation}`,
    };
  return { code: 'unknown', message: errorMessage(error) };
}
