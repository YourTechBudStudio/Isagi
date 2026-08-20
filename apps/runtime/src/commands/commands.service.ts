import { Context, Effect, Either, Layer } from 'effect';

import type {
  CommandActionOutput,
  CommandLogMetadataOutput,
  CommandStatus,
  CommandSummary,
  WorktreeCommandsOutput,
} from '@isagi/contracts';

import { loadWorktreeCommandCatalog } from '../project-config/project-config.service.js';
import { PtyRepository, PtyService } from '../pty-processes/index.js';
import { nextRuntimeEventEnvelope, RuntimeEventBus } from '../runtime-events/event-bus.js';
import { InternalRuntimeEventBus } from '../runtime-events/internal-event-bus.js';
import { WorkspaceRepository } from '../workspace/index.js';
import { CommandError, type CommandServiceError } from './commands.errors.js';
import { makeCommandLauncher } from './commands.launch.js';
import {
  runtimeStoppedDiagnosticDetail,
  terminalCommandOutcomeForPtyRow,
  type CommandRunDiagnosticInput,
  type TerminalRunStatus,
} from './commands.outcomes.js';
import { CommandRepository, type CommandStateRow } from './commands.repository.js';
import {
  commandActionOutput,
  loadCommandTarget,
  resolveReadableCommand,
  resolveStoppableCommand,
} from './commands.targets.js';

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

    // The single writer of a command's terminal outcome from a live PTY
    // incarnation: one transaction completes the run and transitions the state,
    // and the event is published after the commit and only when the state
    // actually moved. Both the synchronous stop paths and the async PTY-exit
    // reconciler funnel through here, so a late echo from a superseded process
    // finds a terminal run and a pointer that no longer names it, changes
    // nothing, and — crucially — announces nothing over the newer status.
    //
    // `runStatus` and `stateStatus` are separate because the entity and its run
    // history are separate vocabularies: they are equal for every caller today,
    // and Phase 07's deactivation stop writes run `stopped` with state
    // `suspended` through this same seam.
    //
    // Callers hold the command lock for the (worktreeId, commandName) being
    // finalized.
    const finalizeCommandRunByPty = (input: {
      readonly worktreeId: number;
      readonly commandName: string;
      readonly ptyProcessId: number;
      readonly runStatus: TerminalRunStatus;
      readonly stateStatus: CommandStatus;
      readonly runDiagnostic?: CommandRunDiagnosticInput | null | undefined;
      readonly publishChange?: boolean | undefined;
    }) =>
      Effect.gen(function* () {
        const result = yield* commandRepository.finalizeRunAndStateByPty({
          worktreeId: input.worktreeId,
          commandName: input.commandName,
          ptyProcessId: input.ptyProcessId,
          runStatus: input.runStatus,
          stateStatus: input.stateStatus,
          diagnosticReason: input.runDiagnostic?.reason ?? null,
          diagnosticDetail: input.runDiagnostic?.detail ?? null,
        });
        if (result.stateTransitioned && (input.publishChange ?? true)) {
          yield* publishCommandChanged(input.worktreeId, input.commandName, input.stateStatus);
        }
        return result;
      });

    // The launch flow lives in `commands.launch.ts`; the layer keeps ownership of
    // the lock, the event bus, and every path that ends a live incarnation.
    const { runCommand } = makeCommandLauncher({
      workspaceRepository,
      commandRepository,
      ptyRepository,
      pty,
      publishCommandChanged,
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
        // Nothing was there to stop, so this call caused nothing and must not
        // claim a `stopped` that never happened. The incarnation's real terminal
        // fact — a captured exit, or the poller's verdict — owns the outcome and
        // reconciles the command when it lands.
        if (terminate.right === 'already_absent') {
          return commandActionOutput(target, state.status);
        }

        yield* finalizeCommandRunByPty({
          worktreeId: target.worktree.id,
          commandName: target.commandName,
          ptyProcessId: state.activePtyProcessId,
          runStatus: 'stopped',
          stateStatus: 'stopped',
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
          // See `stopCommand`: an absent process leaves the durable outcome to
          // whatever actually ended it.
          if (terminate.right === 'already_absent') return;
          yield* finalizeCommandRunByPty({
            worktreeId: state.worktreeId,
            commandName: state.commandName,
            ptyProcessId: state.activePtyProcessId,
            runStatus: 'stopped',
            stateStatus: 'stopped',
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
        const outcome = terminalCommandOutcomeForPtyRow(
          event.type === 'pty_process_exited'
            ? { status: 'exited', exitCode: event.exitCode }
            : {
                status: event.type === 'pty_process_killed' ? 'killed' : 'failed',
                statusReason: event.statusReason,
              },
          'event',
        );
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
            runStatus: outcome.runStatus,
            stateStatus: outcome.runStatus,
            runDiagnostic: outcome.diagnostic,
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
            diagnosticDetail: runtimeStoppedDiagnosticDetail,
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
