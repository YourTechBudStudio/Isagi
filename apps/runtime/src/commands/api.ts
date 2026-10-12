import { Data, Effect, type Layer, Result, Schema } from 'effect';
import type { FastifyInstance } from 'fastify';

import {
  apiEndpoints,
  commandLogStreamWebSocketEndpoint,
  ptyWebSocketInputMessageSchema,
  type CommandLogStreamErrorCode,
  type CommandLogStreamOutputMessage,
} from '@isagi/contracts';

import {
  errorMessage,
  registerApiEndpoint,
  type Rejection,
  type RouteRuntime,
} from '../platform/http/index.js';
import {
  type PtyService,
  type PtyServiceError,
  registerPtyStreamRoute,
  type PtyStreamStrategy,
} from '../pty-processes/index.js';
import { type CommandError, type CommandServiceError } from './errors.js';
import type { CommandsLayer } from './layer.js';
import { CommandService } from './service.js';

class CommandLogStreamProtocolError extends Data.TaggedError('CommandLogStreamProtocolError')<{
  readonly code: 'command_not_found' | 'read_only_stream';
  readonly message: string;
}> {}

/** Every commands endpoint declares the same error union, so one rejection type serves them all. */
type CommandsRejection = Rejection<typeof apiEndpoints.commands.listForWorktree>;

/**
 * The commands module's routes. Typed by the module's own layer plus `PtyService`, which the command log stream
 * reads, so the module never imports the composition root.
 *
 * Every JSON endpoint maps `CommandError` to `worktree_commands_rejected`; `DatabaseError` passes through to the
 * platform's `runtime_database_failed` mapping, which every commands endpoint declares.
 */
export function registerCommandsRoutes(
  fastify: FastifyInstance,
  runtime: RouteRuntime<Layer.Success<typeof CommandsLayer> | PtyService>,
) {
  registerApiEndpoint(fastify, runtime, apiEndpoints.commands.listForWorktree, (request) =>
    CommandService.use((commands) => commands.listForWorktree(request.params.worktreeId)).pipe(
      Effect.catchTags({
        CommandError: (error) => request.reject(commandRejection(error)),
      }),
    ),
  );

  registerApiEndpoint(fastify, runtime, apiEndpoints.commands.logMetadata, (request) =>
    CommandService.use((commands) =>
      commands.readLogMetadata({
        worktreeId: request.params.worktreeId,
        commandName: request.query.commandName,
      }),
    ).pipe(
      Effect.catchTags({
        CommandError: (error) => request.reject(commandRejection(error)),
      }),
    ),
  );

  registerApiEndpoint(fastify, runtime, apiEndpoints.commands.run, (request) =>
    CommandService.use((commands) =>
      commands.run({
        worktreeId: request.params.worktreeId,
        commandName: request.body.commandName,
      }),
    ).pipe(
      Effect.catchTags({
        CommandError: (error) => request.reject(commandRejection(error)),
      }),
    ),
  );

  registerApiEndpoint(fastify, runtime, apiEndpoints.commands.stop, (request) =>
    CommandService.use((commands) =>
      commands.stop({
        worktreeId: request.params.worktreeId,
        commandName: request.body.commandName,
      }),
    ).pipe(
      Effect.catchTags({
        CommandError: (error) => request.reject(commandRejection(error)),
      }),
    ),
  );

  registerApiEndpoint(fastify, runtime, apiEndpoints.commands.restart, (request) =>
    CommandService.use((commands) =>
      commands.restart({
        worktreeId: request.params.worktreeId,
        commandName: request.body.commandName,
      }),
    ).pipe(
      Effect.catchTags({
        CommandError: (error) => request.reject(commandRejection(error)),
      }),
    ),
  );

  registerCommandLogStreamRoute(fastify, runtime);
}

/** The contract rejection for a `CommandError`; every commands endpoint maps it with this, next to the endpoint. */
function commandRejection(error: CommandError): CommandsRejection {
  return {
    code: 'worktree_commands_rejected',
    status: commandRejectionStatus(error.code),
    message: error.message,
    data: {
      reason: error.code,
      ...(error.worktreeId ? { worktreeId: error.worktreeId } : {}),
      ...(error.commandName ? { commandName: error.commandName } : {}),
    },
  };
}

function commandRejectionStatus(reason: CommandError['code']): 400 | 500 {
  switch (reason) {
    case 'worktree_not_found':
    case 'command_config_invalid':
    case 'command_not_found':
      return 400;
    // `command_action_failed` is an operational failure (a PTY termination that
    // did not go through), not a request the caller can fix — surface it as a
    // degraded-runtime 500 so it reads differently from validation/not-found.
    case 'command_action_failed':
      return 500;
  }
}

function registerCommandLogStreamRoute(
  fastify: FastifyInstance,
  runtime: RouteRuntime<CommandService | PtyService>,
) {
  const strategy: PtyStreamStrategy<
    {
      readonly metadata: Extract<
        CommandLogStreamOutputMessage,
        { readonly type: 'command_log_state' }
      >;
    },
    Extract<CommandLogStreamOutputMessage, { readonly type: 'command_log_state' }>,
    CommandLogStreamProtocolError | CommandServiceError,
    CommandService | PtyService
  > = {
    path: commandLogStreamWebSocketEndpoint.path,
    logLabel: 'Command log stream',
    mode: 'read_only',
    closeOnExit: true,
    closeOnReplayOnly: true,
    closeOnClientError: true,
    resolveTarget: (request) => {
      const worktreeId = decodeWorktreeId(request.params);
      const commandName = decodeCommandName(request.query);
      if (worktreeId === null || commandName === null) {
        return Effect.fail(
          new CommandLogStreamProtocolError({
            code: 'command_not_found',
            message: 'Command log stream target was invalid.',
          }),
        );
      }
      return readLogStreamTarget(worktreeId, commandName);
    },
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
    // A backend that cannot attach falls back to the command's file log.
    recoverAttachFailure: ({ target, cause }) =>
      cause._tag === 'PtyServiceError' && cause.code === 'backend_attach_failed'
        ? readLogStreamTarget(target.metadata.worktreeId, target.metadata.commandName)
        : Effect.succeed(null),
    supersede: () => true,
    displace: ({ controls }) =>
      controls
        .send({ type: 'error', code: 'stream_superseded' })
        .pipe(Effect.andThen(controls.detach), Effect.andThen(controls.close)),
    registerAttachment: () => Effect.succeed(() => {}),
    mapError: commandLogStreamError,
  };

  registerPtyStreamRoute(fastify, runtime, strategy);
}

/** A command's log state as a stream target: the state frame, and the PTY process its latest run names. */
const readLogStreamTarget = Effect.fnUntraced(function* (worktreeId: number, commandName: string) {
  const metadata = yield* CommandService.use((commands) =>
    commands.readLogMetadata({ worktreeId, commandName }),
  );
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
});

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
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const decoded = Schema.decodeUnknownResult(ptyWebSocketInputMessageSchema)(parsed);
  return Result.isSuccess(decoded) ? decoded.success : null;
}

/** Everything a command log stream connection can fail with, mapped to its socket error frame. */
function commandLogStreamError(
  error: CommandLogStreamProtocolError | CommandServiceError | PtyServiceError,
): {
  readonly code: CommandLogStreamErrorCode;
  readonly message?: string;
} {
  switch (error._tag) {
    case 'CommandLogStreamProtocolError':
      return { code: error.code, message: error.message };
    case 'CommandError':
      switch (error.code) {
        case 'worktree_not_found':
        case 'command_config_invalid':
        case 'command_not_found':
          return { code: error.code, message: error.message };
        case 'command_action_failed':
          return { code: 'unknown', message: error.message };
      }
    case 'PtyServiceError':
      return ptyServiceStreamError(error);
    case 'DatabaseError':
      return {
        code: 'pty_state_load_failed',
        message: `PTY state load failed: ${error.operation}`,
      };
  }
}

function ptyServiceStreamError(error: PtyServiceError): {
  readonly code: CommandLogStreamErrorCode;
  readonly message?: string;
} {
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
    case 'worktree_not_found':
      return { code: 'unknown', message: errorMessage(error) };
  }
}
