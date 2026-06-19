import { Context, Data, Effect, Layer } from 'effect';

import type { WorktreeCommandsOutput } from '@isagi/contracts';

import type { DatabaseError } from '../persistence/index.js';
import { loadWorktreeCommandCatalog } from '../project-config/project-config.service.js';
import { WorkspaceRepository } from '../workspace/index.js';

export class CommandError extends Data.TaggedError('CommandError')<{
  readonly code: 'worktree_not_found';
  readonly message: string;
  readonly worktreeId?: number | undefined;
}> {}

export type CommandServiceError = CommandError | DatabaseError;

export interface CommandService {
  readonly listForWorktree: (
    worktreeId: number,
  ) => Effect.Effect<WorktreeCommandsOutput, CommandServiceError>;
}

export const CommandService = Context.GenericTag<CommandService>('isagi/CommandService');

export const CommandServiceLive = Layer.effect(
  CommandService,
  Effect.gen(function* () {
    const workspaceRepository = yield* WorkspaceRepository;

    return {
      listForWorktree: (worktreeId) =>
        Effect.gen(function* () {
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

          const catalog = yield* loadWorktreeCommandCatalog({
            worktreeRootPath: worktree.path,
          });

          if (catalog.status === 'config_error') {
            return {
              status: 'config_error',
              worktreeId,
              diagnostic: catalog.diagnostic,
            } satisfies WorktreeCommandsOutput;
          }

          return {
            status: 'configured',
            worktreeId,
            commands: catalog.config.commands.map((command) => ({
              name: command.name,
              status: 'idle',
              ports: [...command.ports],
            })),
          } satisfies WorktreeCommandsOutput;
        }),
    } satisfies CommandService;
  }),
);
