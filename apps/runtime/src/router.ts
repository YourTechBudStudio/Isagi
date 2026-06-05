import { implement, ORPCError } from '@orpc/server';
import { Effect, type ManagedRuntime } from 'effect';

import { contract } from '@isagi/contracts';

import { GitCommandError, ProjectPathValidationError } from './git/index.js';
import { getRuntimeHealth } from './health.js';
import { suggestPaths } from './paths/index.js';
import { DataDirectoryError, DatabaseError, StateFileError } from './persistence/index.js';
import type { RuntimeServices } from './runtime-layer.js';
import { WorkspaceError, WorkspaceService } from './workspace/index.js';

const os = implement(contract);

type RuntimeRequestRuntime = ManagedRuntime.ManagedRuntime<RuntimeServices, unknown>;

export function createRouter(runtime: RuntimeRequestRuntime) {
  return os.router({
    health: os.health.handler(() => Effect.runSync(getRuntimeHealth())),
    workspace: {
      get: os.workspace.get.handler(() =>
        runHandler(
          'workspace.get',
          runtime,
          Effect.gen(function* () {
            const workspace = yield* WorkspaceService;
            return yield* workspace.get;
          }),
        ),
      ),
      setActiveContext: os.workspace.setActiveContext.handler(({ input }) =>
        runHandler(
          'workspace.setActiveContext',
          runtime,
          Effect.gen(function* () {
            const workspace = yield* WorkspaceService;
            return yield* workspace.setActiveContext(input);
          }),
        ),
      ),
    },
    projects: {
      add: os.projects.add.handler(({ input }) =>
        runHandler(
          'projects.add',
          runtime,
          Effect.gen(function* () {
            const workspace = yield* WorkspaceService;
            return yield* workspace.registerProject(input);
          }),
        ),
      ),
    },
    paths: {
      suggest: os.paths.suggest.handler(({ input }) =>
        runStatelessHandler('paths.suggest', suggestPaths(input)),
      ),
    },
  });
}

function runHandler<T, E>(
  operation: string,
  runtime: RuntimeRequestRuntime,
  effect: Effect.Effect<T, E, RuntimeServices>,
) {
  return runtime
    .runPromise(effect.pipe(Effect.mapError((error) => toRpcError(error, operation))))
    .catch((error: unknown) => {
      throw toUnhandledRpcError(error, operation);
    });
}

function runStatelessHandler<T, E>(operation: string, effect: Effect.Effect<T, E>) {
  return Effect.runPromise(
    effect.pipe(Effect.mapError((error) => toRpcError(error, operation))),
  ).catch((error: unknown) => {
    throw toUnhandledRpcError(error, operation);
  });
}

function toRpcError(error: unknown, operation: string) {
  if (error instanceof ProjectPathValidationError) {
    return new ORPCError(error.code, {
      status: 400,
      message: error.message,
      data: { code: error.code, path: error.path },
    });
  }

  if (error instanceof WorkspaceError) {
    return new ORPCError(error.code, {
      status: 400,
      message: error.message,
      data: { code: error.code },
    });
  }

  if (error instanceof GitCommandError) {
    return new ORPCError('git_command_failed', {
      status: 500,
      message: `git ${error.args.join(' ')} failed${error.stderr ? `: ${error.stderr.trim()}` : ''}`,
      data: { code: 'git_command_failed' },
    });
  }

  if (error instanceof DatabaseError) {
    return new ORPCError('database_error', {
      status: 500,
      message: `Database operation failed: ${error.operation}`,
      data: { code: 'database_error', operation: error.operation },
    });
  }

  if (error instanceof StateFileError) {
    return new ORPCError('state_file_error', {
      status: 500,
      message: `State file operation failed: ${error.operation}`,
      data: { code: 'state_file_error', operation: error.operation },
    });
  }

  if (error instanceof DataDirectoryError) {
    return new ORPCError('data_directory_error', {
      status: 500,
      message: 'Could not prepare the Isagi data directory.',
      data: { code: 'data_directory_error' },
    });
  }

  return toUnhandledRpcError(error, operation);
}

function toUnhandledRpcError(error: unknown, operation: string) {
  if (error instanceof ORPCError) {
    return error;
  }

  console.error(`[runtime] Unhandled oRPC handler error during ${operation}`, error);

  return new ORPCError('INTERNAL_SERVER_ERROR', {
    status: 500,
    message: errorMessage(error),
    data: { code: 'runtime_error' },
  });
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'string' && error) {
    return error;
  }
  return 'Unhandled runtime error';
}
