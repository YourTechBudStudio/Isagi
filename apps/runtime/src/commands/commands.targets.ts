import { Effect } from 'effect';

import type { CommandActionOutput, CommandStatus } from '@isagi/contracts';

import type { WorktreeCommandConfig } from '../project-config/project-config.schema.js';
import { loadWorktreeCommandCatalog } from '../project-config/project-config.service.js';
import type { WorkspaceRepositoryService } from '../workspace/index.js';
import { CommandError, type CommandServiceError } from './commands.errors.js';
import type { CommandRepositoryService } from './commands.repository.js';

// Resolving a (worktreeId, commandName) request to the thing it names, and
// shaping the action result the API returns. Each resolver encodes what its
// callers are allowed to act on: a configured command to launch, anything the
// user can read, anything the runtime can still stop.

export interface CommandTarget {
  readonly worktree: { readonly id: number; readonly path: string };
  readonly command: WorktreeCommandConfig;
}

export interface ManagedCommandTarget {
  readonly worktree: { readonly id: number; readonly path: string };
  readonly commandName: string;
  readonly ports: readonly number[];
}

export function resolveConfiguredCommand(
  workspaceRepository: WorkspaceRepositoryService,
  input: { readonly worktreeId: number; readonly commandName: string },
): Effect.Effect<CommandTarget, CommandServiceError> {
  return Effect.gen(function* () {
    const target = yield* loadCommandTarget(workspaceRepository, input.worktreeId);
    const catalog = yield* loadWorktreeCommandCatalog({ worktreeRootPath: target.worktree.path });
    if (catalog.status === 'config_error') {
      return yield* Effect.fail(
        new CommandError({
          code: 'command_config_invalid',
          message: catalog.diagnostic.message,
          worktreeId: input.worktreeId,
          commandName: input.commandName,
        }),
      );
    }
    const command = catalog.config.commands.find(
      (candidate) => candidate.name === input.commandName,
    );
    if (!command) {
      return yield* Effect.fail(
        new CommandError({
          code: 'command_not_found',
          message: `Command ${input.commandName} was not found.`,
          worktreeId: input.worktreeId,
          commandName: input.commandName,
        }),
      );
    }
    return { worktree: target.worktree, command };
  });
}

export function resolveReadableCommand(
  workspaceRepository: WorkspaceRepositoryService,
  commandRepository: CommandRepositoryService,
  input: { readonly worktreeId: number; readonly commandName: string },
): Effect.Effect<void, CommandServiceError> {
  return Effect.gen(function* () {
    const target = yield* loadCommandTarget(workspaceRepository, input.worktreeId);
    const catalog = yield* loadWorktreeCommandCatalog({ worktreeRootPath: target.worktree.path });
    if (catalog.status === 'configured') {
      const configured = catalog.config.commands.some(
        (candidate) => candidate.name === input.commandName,
      );
      if (configured) return;
    }

    const state = yield* commandRepository.findState(input);
    const run = yield* commandRepository.findLatestRun(input);
    if (state || run) return;

    return yield* Effect.fail(
      new CommandError({
        code: catalog.status === 'config_error' ? 'command_config_invalid' : 'command_not_found',
        message:
          catalog.status === 'config_error'
            ? catalog.diagnostic.message
            : `Command ${input.commandName} was not found.`,
        worktreeId: input.worktreeId,
        commandName: input.commandName,
      }),
    );
  });
}

export function resolveStoppableCommand(
  workspaceRepository: WorkspaceRepositoryService,
  commandRepository: CommandRepositoryService,
  input: { readonly worktreeId: number; readonly commandName: string },
): Effect.Effect<ManagedCommandTarget, CommandServiceError> {
  return Effect.gen(function* () {
    const target = yield* loadCommandTarget(workspaceRepository, input.worktreeId);
    const catalog = yield* loadWorktreeCommandCatalog({ worktreeRootPath: target.worktree.path });
    if (catalog.status === 'configured') {
      const command = catalog.config.commands.find(
        (candidate) => candidate.name === input.commandName,
      );
      if (command) {
        return { worktree: target.worktree, commandName: command.name, ports: command.ports };
      }
    }

    const state = yield* commandRepository.findState(input);
    if (state?.status === 'running') {
      return { worktree: target.worktree, commandName: state.commandName, ports: [] };
    }

    return yield* Effect.fail(
      new CommandError({
        code: catalog.status === 'config_error' ? 'command_config_invalid' : 'command_not_found',
        message:
          catalog.status === 'config_error'
            ? catalog.diagnostic.message
            : `Command ${input.commandName} was not found.`,
        worktreeId: input.worktreeId,
        commandName: input.commandName,
      }),
    );
  });
}

export function loadCommandTarget(
  workspaceRepository: WorkspaceRepositoryService,
  worktreeId: number,
) {
  return Effect.gen(function* () {
    const worktree = yield* workspaceRepository.findWorktree(worktreeId);
    if (!worktree) {
      return yield* Effect.fail(
        new CommandError({
          code: 'worktree_not_found',
          message: `Worktree ${worktreeId} was not found.`,
          worktreeId,
        }),
      );
    }
    return { worktree };
  });
}

export function actionOutput(
  command: WorktreeCommandConfig,
  status: CommandStatus,
  worktreeId: number,
): CommandActionOutput {
  return {
    worktreeId,
    commandName: command.name,
    summary: {
      name: command.name,
      status,
      ports: status === 'running' ? [...command.ports] : [],
    },
  };
}

export function commandActionOutput(
  target: ManagedCommandTarget,
  status: CommandStatus,
): CommandActionOutput {
  return {
    worktreeId: target.worktree.id,
    commandName: target.commandName,
    summary: {
      name: target.commandName,
      status,
      ports: status === 'running' ? [...target.ports] : [],
    },
  };
}
