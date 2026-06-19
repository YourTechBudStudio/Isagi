import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

import { Context, Data, Effect, Either, Layer } from 'effect';

import type {
  CommandActionOutput,
  CommandLogMetadataOutput,
  CommandRunDiagnosticReason,
  CommandSummary,
  CommandStatus,
  WorktreeCommandsOutput,
  WorktreeCommandsRejectionReason,
} from '@isagi/contracts';

import type { DatabaseError } from '../persistence/index.js';
import type { WorktreeCommandConfig } from '../project-config/command-config.schema.js';
import { loadWorktreeCommandCatalog } from '../project-config/project-config.service.js';
import { PtyRepository, PtyService } from '../pty-processes/index.js';
import { nextRuntimeEventEnvelope, RuntimeEventBus } from '../runtime-events/event-bus.js';
import { InternalRuntimeEventBus } from '../runtime-events/internal-event-bus.js';
import { WorkspaceRepository } from '../workspace/index.js';
import {
  CommandRepository,
  type CommandRepositoryService,
  type CommandStateRow,
} from './commands.repository.js';
import { parseDotenv } from './dotenv.js';

export class CommandError extends Data.TaggedError('CommandError')<{
  readonly code: WorktreeCommandsRejectionReason;
  readonly message: string;
  readonly worktreeId?: number | undefined;
  readonly commandName?: string | undefined;
  readonly cause?: unknown;
}> {}

export type CommandServiceError = CommandError | DatabaseError;

export interface CommandService {
  readonly listForWorktree: (
    worktreeId: number,
  ) => Effect.Effect<WorktreeCommandsOutput, CommandServiceError>;
  readonly readLogMetadata: (input: {
    readonly worktreeId: number;
    readonly commandName: string;
  }) => Effect.Effect<CommandLogMetadataOutput, CommandServiceError>;
  readonly run: (input: {
    readonly worktreeId: number;
    readonly commandName: string;
  }) => Effect.Effect<CommandActionOutput, CommandServiceError>;
  readonly stop: (input: {
    readonly worktreeId: number;
    readonly commandName: string;
  }) => Effect.Effect<CommandActionOutput, CommandServiceError>;
  readonly restart: (input: {
    readonly worktreeId: number;
    readonly commandName: string;
  }) => Effect.Effect<CommandActionOutput, CommandServiceError>;
  readonly runPostCreateLifecycle: (input: {
    readonly worktreeId: number;
  }) => Effect.Effect<void, never>;
  readonly cleanupBeforeWorktreeDelete: (input: {
    readonly worktreeId: number;
  }) => Effect.Effect<void, CommandServiceError>;
  readonly cleanupBeforeWorktreePrune: (input: {
    readonly worktreeId: number;
  }) => Effect.Effect<void, CommandServiceError>;
  readonly reconcileStaleRunningCommands: Effect.Effect<void, never>;
}

export const CommandService = Context.GenericTag<CommandService>('isagi/CommandService');

const commandStopGracefulTimeoutMs = 2_000;

// Keep only the newest run per command. Each retained run pins a PTY row + log
// for GC, and only the latest run is ever read, so one is the right bound.
const latestCommandRunsToRetain = 1;

type TerminalCommandStatus = Exclude<CommandStatus, 'idle' | 'running'>;

type PtyCommandEvent =
  | {
      readonly type: 'pty_process_exited';
      readonly ptyProcessId: number;
      readonly exitCode: number | null;
      readonly signal: string | null;
    }
  | {
      readonly type: 'pty_process_failed';
      readonly ptyProcessId: number;
      readonly statusReason: string | null;
    }
  | {
      readonly type: 'pty_process_killed';
      readonly ptyProcessId: number;
      readonly statusReason: string | null;
    };

export const CommandServiceLive = Layer.scoped(
  CommandService,
  Effect.gen(function* () {
    const workspaceRepository = yield* WorkspaceRepository;
    const commandRepository = yield* CommandRepository;
    const ptyRepository = yield* PtyRepository;
    const pty = yield* PtyService;
    const publicEvents = yield* RuntimeEventBus;
    const internalEvents = yield* InternalRuntimeEventBus;
    const locks: CommandLocks = new Map();

    const publishCommandChanged = (
      worktreeId: number,
      commandName: string,
      status: CommandStatus,
    ) =>
      publicEvents.publish({
        ...nextRuntimeEventEnvelope(),
        type: 'command_changed',
        payload: { worktreeId, commandName, status },
      });

    // The single writer of a run's terminal state from a live PTY incarnation:
    // complete the run, append an optional marker, clear the command's active
    // pointer when it still points at this PTY, and announce the change. Both the
    // synchronous stop paths and the async PTY-exit reconciler funnel through
    // here so the sequence can never drift between them. Callers hold the command
    // lock for the (worktreeId, commandName) being finalized.
    const finalizeCommandRunByPty = (input: {
      readonly worktreeId: number;
      readonly commandName: string;
      readonly ptyProcessId: number;
      readonly status: TerminalCommandStatus;
      readonly publishChange?: boolean | undefined;
    }) =>
      Effect.gen(function* () {
        yield* commandRepository.completeRunByPtyProcess({
          ptyProcessId: input.ptyProcessId,
          status: input.status,
        });
        const state = yield* commandRepository.findState({
          worktreeId: input.worktreeId,
          commandName: input.commandName,
        });
        if (state?.activePtyProcessId === input.ptyProcessId) {
          yield* commandRepository.transitionState({
            worktreeId: input.worktreeId,
            commandName: input.commandName,
            status: input.status,
            activePtyProcessId: null,
          });
        }
        if (input.publishChange ?? true) {
          yield* publishCommandChanged(input.worktreeId, input.commandName, input.status);
        }
      });

    const runCommand = (input: { readonly worktreeId: number; readonly commandName: string }) =>
      Effect.gen(function* () {
        const target = yield* resolveConfiguredCommand(workspaceRepository, input);
        const current = yield* commandRepository.findState(input);
        if (current?.status === 'running') {
          return actionOutput(target.command, current.status, target.worktree.id);
        }

        const cwd = resolve(target.worktree.path, target.command.cwd ?? '.');
        if (!directoryExists(cwd)) {
          return yield* failedRun(target, 'missing_cwd', target.command.cwd ?? '.');
        }

        const envResult = yield* buildCommandEnv(target.worktree.path, target.command).pipe(
          Effect.either,
        );
        if (Either.isLeft(envResult)) {
          return yield* failedRun(target, 'env_invalid', envResult.left.message);
        }

        const run = yield* commandRepository.createRun({
          worktreeId: target.worktree.id,
          commandName: target.command.name,
          status: 'running',
        });
        yield* pruneCommandRunHistory(commandRepository, {
          worktreeId: target.worktree.id,
          commandName: target.command.name,
        });
        yield* commandRepository.transitionState({
          worktreeId: target.worktree.id,
          commandName: target.command.name,
          status: 'running',
          activePtyProcessId: null,
        });

        const shell = process.env.SHELL && process.env.SHELL.trim() ? process.env.SHELL : '/bin/sh';
        const launch = yield* pty
          .launch({
            command: shell,
            args: ['-lc', target.command.command],
            cwd,
            env: envResult.right,
            shellIntegration: false,
          })
          .pipe(Effect.either);

        if (Either.isLeft(launch)) {
          yield* commandRepository.completeRun({
            runId: run.id,
            status: 'failed',
            diagnosticReason: 'pty_launch_failed',
            diagnosticDetail: diagnosticDetailForCause(launch.left),
          });
          yield* commandRepository.transitionState({
            worktreeId: target.worktree.id,
            commandName: target.command.name,
            status: 'failed',
            activePtyProcessId: null,
          });
          yield* publishCommandChanged(target.worktree.id, target.command.name, 'failed');
          return actionOutput(target.command, 'failed', target.worktree.id);
        }

        yield* commandRepository.updateRunPty({
          runId: run.id,
          ptyProcessId: launch.right.ptyProcessId,
        });
        const processRow = yield* ptyRepository.findProcess(launch.right.ptyProcessId);
        if (processRow?.status === 'failed') {
          yield* commandRepository.completeRun({
            runId: run.id,
            status: 'failed',
            diagnosticReason: 'pty_launch_failed',
            diagnosticDetail: processRow.statusReason,
          });
          yield* commandRepository.transitionState({
            worktreeId: target.worktree.id,
            commandName: target.command.name,
            status: 'failed',
            activePtyProcessId: null,
          });
          yield* publishCommandChanged(target.worktree.id, target.command.name, 'failed');
          return actionOutput(target.command, 'failed', target.worktree.id);
        }

        yield* commandRepository.transitionState({
          worktreeId: target.worktree.id,
          commandName: target.command.name,
          status: 'running',
          activePtyProcessId: launch.right.ptyProcessId,
        });
        yield* publishCommandChanged(target.worktree.id, target.command.name, 'running');
        return actionOutput(target.command, 'running', target.worktree.id);
      });

    const failedRun = (
      target: CommandTarget,
      diagnosticReason: CommandRunDiagnosticReason,
      diagnosticDetail: string,
    ) =>
      Effect.gen(function* () {
        yield* commandRepository.createRun({
          worktreeId: target.worktree.id,
          commandName: target.command.name,
          status: 'failed',
          diagnosticReason,
          diagnosticDetail,
          completedAt: new Date().toISOString(),
        });
        yield* pruneCommandRunHistory(commandRepository, {
          worktreeId: target.worktree.id,
          commandName: target.command.name,
        });
        yield* commandRepository.transitionState({
          worktreeId: target.worktree.id,
          commandName: target.command.name,
          status: 'failed',
          activePtyProcessId: null,
        });
        yield* publishCommandChanged(target.worktree.id, target.command.name, 'failed');
        return actionOutput(target.command, 'failed', target.worktree.id);
      });

    const stopCommand = (
      input: { readonly worktreeId: number; readonly commandName: string },
      options: {
        readonly suppressChangedEvent?: boolean | undefined;
      },
    ) =>
      Effect.gen(function* () {
        const target = yield* resolveStoppableCommand(
          workspaceRepository,
          commandRepository,
          input,
        );
        const state = yield* commandRepository.findState(input);
        if (!state || state.status !== 'running' || !state.activePtyProcessId) {
          return commandActionOutput(target, state?.status ?? 'idle');
        }

        const terminate = yield* pty
          .terminate({
            ptyProcessId: state.activePtyProcessId,
            gracefulTimeoutMs: commandStopGracefulTimeoutMs,
          })
          .pipe(Effect.either);
        if (Either.isLeft(terminate)) {
          return yield* Effect.fail(
            new CommandError({
              code: 'command_action_failed',
              message: `Could not stop command ${target.commandName}.`,
              worktreeId: target.worktree.id,
              commandName: target.commandName,
              cause: terminate.left,
            }),
          );
        }

        yield* finalizeCommandRunByPty({
          worktreeId: target.worktree.id,
          commandName: target.commandName,
          ptyProcessId: state.activePtyProcessId,
          status: 'stopped',
          publishChange: !options.suppressChangedEvent,
        });
        return commandActionOutput(target, 'stopped');
      });

    // Bulk stop of a command we already know is running (no config lookup), used
    // when tearing a worktree down. Routes through the same finalizer as manual
    // stop so the completion/event sequence stays identical.
    const stopRunningCommand = (input: {
      readonly worktreeId: number;
      readonly commandName: string;
    }) =>
      Effect.gen(function* () {
        const state = yield* commandRepository.findState(input);
        if (!state || state.status !== 'running') return;
        if (state.activePtyProcessId) {
          const terminate = yield* pty
            .terminate({
              ptyProcessId: state.activePtyProcessId,
              gracefulTimeoutMs: commandStopGracefulTimeoutMs,
            })
            .pipe(Effect.either);
          if (Either.isLeft(terminate)) {
            return yield* Effect.fail(
              new CommandError({
                code: 'command_action_failed',
                message: `Could not stop command ${state.commandName}.`,
                worktreeId: state.worktreeId,
                commandName: state.commandName,
                cause: terminate.left,
              }),
            );
          }
          yield* finalizeCommandRunByPty({
            worktreeId: state.worktreeId,
            commandName: state.commandName,
            ptyProcessId: state.activePtyProcessId,
            status: 'stopped',
          });
          return;
        }
        yield* commandRepository.transitionState({
          worktreeId: state.worktreeId,
          commandName: state.commandName,
          status: 'stopped',
          activePtyProcessId: null,
        });
        yield* publishCommandChanged(state.worktreeId, state.commandName, 'stopped');
      });

    const runConfiguredLifecycleStarts = (input: {
      readonly worktreeId: number;
      readonly lifecycle: 'postCreate' | 'activate';
    }) =>
      Effect.gen(function* () {
        const target = yield* loadCommandTarget(workspaceRepository, input.worktreeId);
        const catalog = yield* loadWorktreeCommandCatalog({
          worktreeRootPath: target.worktree.path,
        });
        if (catalog.status === 'config_error') {
          console.warn(
            `[runtime] Command ${input.lifecycle} lifecycle skipped for worktree ${input.worktreeId}: ${catalog.diagnostic.message}`,
          );
          return;
        }
        for (const command of catalog.config.commands) {
          if (!command.lifecycle[input.lifecycle].start) continue;
          yield* withCommandLock(
            locks,
            { worktreeId: target.worktree.id, commandName: command.name },
            runCommand({ worktreeId: target.worktree.id, commandName: command.name }),
          ).pipe(Effect.catchAll(logLifecycleError(`${input.lifecycle}:${command.name}`)));
        }
      });

    const stopConfiguredLifecycleCommands = (input: {
      readonly worktreeId: number;
      readonly lifecycle: 'deactivate' | 'preDelete';
      // `deactivate` is best-effort: a stalled stop must not block the activation
      // change, so we log and continue. `preDelete` must propagate, so a worktree
      // delete can report `command_cleanup_failed` rather than silently orphan a
      // still-running process.
      readonly onCommandStopError: 'log' | 'propagate';
    }) =>
      Effect.gen(function* () {
        const target = yield* loadCommandTarget(workspaceRepository, input.worktreeId);
        const catalog = yield* loadWorktreeCommandCatalog({
          worktreeRootPath: target.worktree.path,
        });
        if (catalog.status === 'config_error') {
          console.warn(
            `[runtime] Command ${input.lifecycle} lifecycle skipped for worktree ${input.worktreeId}: ${catalog.diagnostic.message}`,
          );
          return;
        }
        for (const command of catalog.config.commands) {
          if (!command.lifecycle[input.lifecycle].stop) continue;
          const stop = withCommandLock(
            locks,
            { worktreeId: target.worktree.id, commandName: command.name },
            stopCommand({ worktreeId: target.worktree.id, commandName: command.name }, {}),
          );
          yield* input.onCommandStopError === 'log'
            ? stop.pipe(Effect.catchAll(logLifecycleError(`${input.lifecycle}:${command.name}`)))
            : stop;
        }
      });

    const stopAllRunningCommandsForWorktree = (input: { readonly worktreeId: number }) =>
      Effect.gen(function* () {
        const states = yield* commandRepository.listRunningStatesForWorktree(input.worktreeId);
        for (const state of states) {
          yield* withCommandLock(
            locks,
            { worktreeId: state.worktreeId, commandName: state.commandName },
            stopRunningCommand({
              worktreeId: state.worktreeId,
              commandName: state.commandName,
            }),
          );
        }
      });

    const applyActivationLifecycle = (
      previousWorktreeId: number | null,
      nextWorktreeId: number | null,
    ) =>
      Effect.gen(function* () {
        if (previousWorktreeId !== null) {
          yield* stopConfiguredLifecycleCommands({
            worktreeId: previousWorktreeId,
            lifecycle: 'deactivate',
            onCommandStopError: 'log',
          }).pipe(Effect.catchAll(logLifecycleError('deactivate')));
        }
        if (nextWorktreeId !== null) {
          yield* runConfiguredLifecycleStarts({
            worktreeId: nextWorktreeId,
            lifecycle: 'activate',
          }).pipe(Effect.catchAll(logLifecycleError('activate')));
        }
      });

    const reconcilePtyProcessEvent = (event: PtyCommandEvent) =>
      Effect.gen(function* () {
        const status: TerminalCommandStatus =
          event.type === 'pty_process_exited'
            ? event.exitCode === 0
              ? 'exited'
              : 'failed'
            : event.type === 'pty_process_killed' && event.statusReason === 'user_requested'
              ? 'stopped'
              : 'failed';
        // Find the owning command without the lock to derive the lock key, then
        // finalize under the lock so we serialize against in-flight run/stop. A
        // superseded (already-pruned) run resolves to null and we skip.
        const run = yield* commandRepository.findRunByPtyProcess(event.ptyProcessId);
        if (!run) return;
        yield* withCommandLock(
          locks,
          { worktreeId: run.worktreeId, commandName: run.commandName },
          finalizeCommandRunByPty({
            worktreeId: run.worktreeId,
            commandName: run.commandName,
            ptyProcessId: event.ptyProcessId,
            status,
          }),
        );
      });

    // Startup recovery: any command still marked running was orphaned by a
    // runtime restart (its ephemeral PTY is gone and no exit event will arrive),
    // so mark it failed directly. Not a live-PTY path, so it bypasses the
    // finalizer.
    const reconcileStaleRunningCommands = Effect.gen(function* () {
      const states = yield* commandRepository.listRunningStates;
      for (const state of states) {
        const run = state.activePtyProcessId
          ? yield* commandRepository.findRunByPtyProcess(state.activePtyProcessId)
          : yield* commandRepository.findLatestRun(state);
        if (run?.status === 'running') {
          yield* commandRepository.completeRun({
            runId: run.id,
            status: 'failed',
            diagnosticReason: 'runtime_stopped',
            diagnosticDetail: 'Runtime stopped while this command was running. Not restarted.',
          });
        }
        yield* commandRepository.transitionState({
          worktreeId: state.worktreeId,
          commandName: state.commandName,
          status: 'failed',
          activePtyProcessId: null,
        });
        yield* publishCommandChanged(state.worktreeId, state.commandName, 'failed');
      }
    });

    yield* reconcileStaleRunningCommands.pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => {
          console.warn('[runtime] Command stale-running reconciliation failed', error);
        }),
      ),
    );

    const subscription = yield* internalEvents.subscribe({
      types: [
        'pty_process_exited',
        'pty_process_failed',
        'pty_process_killed',
        'worktree_activation_change',
      ],
    });
    yield* Effect.addFinalizer(() => subscription.unsubscribe);
    const logEventError = (error: unknown) =>
      Effect.sync(() => {
        console.warn('[runtime] Command process event reconciliation failed', error);
      });
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const event = yield* subscription.take;
          if (
            event.type === 'pty_process_exited' ||
            event.type === 'pty_process_failed' ||
            event.type === 'pty_process_killed'
          ) {
            // Fork so a PTY-exit event for a command whose lock is currently
            // held (e.g. by an in-flight restart's graceful terminate) cannot
            // stall reconciliation of other commands' events behind it in the
            // queue. The per-command lock still serializes same-command work.
            yield* Effect.forkScoped(
              reconcilePtyProcessEvent(event).pipe(Effect.catchAll(logEventError)),
            );
            return;
          }
          // Activation changes stay inline so consecutive worktree switches keep
          // their deactivate-then-activate ordering.
          if (event.type === 'worktree_activation_change') {
            yield* applyActivationLifecycle(event.previousWorktreeId, event.nextWorktreeId).pipe(
              Effect.catchAll(logEventError),
            );
          }
        }).pipe(Effect.catchAll(logEventError)),
      ),
    );

    const service = {
      listForWorktree: (worktreeId) =>
        Effect.gen(function* () {
          const target = yield* loadCommandTarget(workspaceRepository, worktreeId);
          const catalog = yield* loadWorktreeCommandCatalog({
            worktreeRootPath: target.worktree.path,
          });

          if (catalog.status === 'config_error') {
            const states = yield* commandRepository.listStatesForWorktree(worktreeId);
            return {
              status: 'config_error',
              worktreeId,
              diagnostic: catalog.diagnostic,
              managedCommands: commandStatesNeedingAttention(states),
            } satisfies WorktreeCommandsOutput;
          }

          const states = yield* commandRepository.listStatesForWorktree(worktreeId);
          const stateByName = new Map(states.map((state) => [state.commandName, state]));
          const configuredNames = new Set(catalog.config.commands.map((command) => command.name));
          return {
            status: 'configured',
            worktreeId,
            commands: catalog.config.commands.map((command) => ({
              name: command.name,
              status: stateByName.get(command.name)?.status ?? 'idle',
              ports: stateByName.get(command.name)?.status === 'running' ? [...command.ports] : [],
            })),
            removedCommands: commandStatesNeedingAttention(
              states.filter((state) => !configuredNames.has(state.commandName)),
            ),
          } satisfies WorktreeCommandsOutput;
        }),
      readLogMetadata: (input) =>
        Effect.gen(function* () {
          yield* resolveReadableCommand(workspaceRepository, commandRepository, input);
          const state = yield* commandRepository.findState(input);
          const run = yield* commandRepository.findLatestRun(input);
          return {
            worktreeId: input.worktreeId,
            commandName: input.commandName,
            status: state?.status ?? 'idle',
            latestRun: run
              ? {
                  id: run.id,
                  startedAt: run.startedAt,
                  completedAt: run.completedAt,
                  status: run.status,
                  ptyProcessId: run.ptyProcessId,
                  hasPtyProcess: run.ptyProcessId !== null,
                  diagnostic: run.diagnosticReason
                    ? {
                        reason: run.diagnosticReason,
                        detail: run.diagnosticDetail,
                      }
                    : null,
                }
              : null,
          } satisfies CommandLogMetadataOutput;
        }),
      run: (input) => withCommandLock(locks, input, runCommand(input)),
      stop: (input) => withCommandLock(locks, input, stopCommand(input, {})),
      restart: (input) =>
        withCommandLock(
          locks,
          input,
          stopCommand(input, { suppressChangedEvent: true }).pipe(
            Effect.zipRight(runCommand(input)),
          ),
        ),
      runPostCreateLifecycle: (input) =>
        runConfiguredLifecycleStarts({
          worktreeId: input.worktreeId,
          lifecycle: 'postCreate',
        }).pipe(Effect.catchAll(logLifecycleError('postCreate'))),
      cleanupBeforeWorktreeDelete: (input) =>
        Effect.gen(function* () {
          yield* stopConfiguredLifecycleCommands({
            worktreeId: input.worktreeId,
            lifecycle: 'preDelete',
            onCommandStopError: 'propagate',
          });
          yield* stopAllRunningCommandsForWorktree({ worktreeId: input.worktreeId });
        }),
      cleanupBeforeWorktreePrune: (input) =>
        stopAllRunningCommandsForWorktree({ worktreeId: input.worktreeId }),
      reconcileStaleRunningCommands: reconcileStaleRunningCommands.pipe(
        Effect.catchAll((error) =>
          Effect.sync(() => {
            console.warn('[runtime] Command stale-running reconciliation failed', error);
          }),
        ),
      ),
    } satisfies CommandService;

    return service;
  }),
);

interface CommandTarget {
  readonly worktree: { readonly id: number; readonly path: string };
  readonly command: WorktreeCommandConfig;
}

interface ManagedCommandTarget {
  readonly worktree: { readonly id: number; readonly path: string };
  readonly commandName: string;
  readonly ports: readonly number[];
}

function resolveConfiguredCommand(
  workspaceRepository: import('../workspace/index.js').WorkspaceRepositoryService,
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

function resolveReadableCommand(
  workspaceRepository: import('../workspace/index.js').WorkspaceRepositoryService,
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

function resolveStoppableCommand(
  workspaceRepository: import('../workspace/index.js').WorkspaceRepositoryService,
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

function loadCommandTarget(
  workspaceRepository: import('../workspace/index.js').WorkspaceRepositoryService,
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

function buildCommandEnv(worktreeRoot: string, command: WorktreeCommandConfig) {
  return Effect.gen(function* () {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const envFile of command.envFiles) {
      const path = resolve(worktreeRoot, envFile);
      if (!existsSync(path)) {
        return yield* Effect.fail(new Error(`Missing env file: ${envFile}`));
      }
      const contents = yield* Effect.tryPromise({
        try: () => readFile(path, 'utf8'),
        catch: (cause) => new Error(`Could not read env file ${envFile}: ${String(cause)}`),
      });
      Object.assign(env, parseDotenv(contents));
    }
    Object.assign(env, command.env);
    return env;
  });
}

// One mutex per (worktree, command) so concurrent run/stop/restart/lifecycle
// actions on the same command serialize, while different commands stay parallel.
// An Effect semaphore (rather than a hand-rolled promise chain) keeps the lock
// interruption-safe: an aborted request releases its permit on the way out.
// Entries are kept for the runtime's lifetime (one tiny semaphore per distinct
// command key ever seen, including after its worktree is deleted) rather than
// reference-counted away — a deliberate, negligible, desktop-scale tradeoff that
// avoids racing entry teardown against an in-flight lock.
type CommandLocks = Map<string, Effect.Semaphore>;

function withCommandLock<A, E, R>(
  locks: CommandLocks,
  input: { readonly worktreeId: number; readonly commandName: string },
  effect: Effect.Effect<A, E, R>,
) {
  const key = `${input.worktreeId}\0${input.commandName}`;
  return Effect.gen(function* () {
    let semaphore = locks.get(key);
    if (!semaphore) {
      semaphore = yield* Effect.makeSemaphore(1);
      locks.set(key, semaphore);
    }
    return yield* semaphore.withPermits(1)(effect);
  });
}

function actionOutput(
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

function commandActionOutput(
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

function commandStatesNeedingAttention(states: readonly CommandStateRow[]): CommandSummary[] {
  return states
    .filter((state) => state.status === 'running' || state.status === 'failed')
    .map((state) => ({
      name: state.commandName,
      status: state.status,
      ports: [],
    }));
}

function logLifecycleError(operation: string) {
  return (error: unknown) =>
    Effect.sync(() => {
      console.warn(`[runtime] Command lifecycle ${operation} failed`, error);
    });
}

function directoryExists(path: string) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function pruneCommandRunHistory(
  commandRepository: CommandRepositoryService,
  input: { readonly worktreeId: number; readonly commandName: string },
) {
  return commandRepository
    .pruneRunHistory({
      ...input,
      keep: latestCommandRunsToRetain,
    })
    .pipe(Effect.asVoid);
}

function diagnosticDetailForCause(cause: unknown) {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
