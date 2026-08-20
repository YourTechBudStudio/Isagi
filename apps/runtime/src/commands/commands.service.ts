import { Context, Effect, Either, Layer } from 'effect';

import type {
  CommandActionOutput,
  CommandLogMetadataOutput,
  CommandStatus,
  CommandSummary,
  WorktreeCommandsOutput,
} from '@isagi/contracts';

import type { DatabaseError } from '../persistence/index.js';
import { loadWorktreeCommandCatalog } from '../project-config/project-config.service.js';
import { PtyRepository, PtyService } from '../pty-processes/index.js';
import { nextRuntimeEventEnvelope, RuntimeEventBus } from '../runtime-events/event-bus.js';
import { InternalRuntimeEventBus } from '../runtime-events/internal-event-bus.js';
import { WorkspaceRepository } from '../workspace/index.js';
import {
  cleanupCommandIncarnations,
  reconcileCommandsAtBoot,
  type CommandConvergenceDependencies,
} from './commands.convergence.js';
import { describeOperationalCause } from './commands.diagnostics.js';
import { CommandError, type CommandServiceError } from './commands.errors.js';
import { makeCommandLauncher } from './commands.launch.js';
import { makeCommandLifecycle } from './commands.lifecycle.js';
import {
  terminalCommandOutcomeForPtyRow,
  terminalPtyFactsForRow,
  type CommandRunDiagnosticInput,
  type CommandStopCause,
  type CommandStopResult,
  type TerminalRunStatus,
} from './commands.outcomes.js';
import {
  CommandRepository,
  type CommandFinalizeResult,
  type CommandStateRow,
} from './commands.repository.js';
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

    // The run-keyed sibling of the finalizer above, for the two flows whose
    // state has no pointer to guard on: a launch converging its own
    // launch-in-progress marker, and pointerless recovery converging a state
    // whose incarnation already ended. Same publish rule — only a real
    // transition is announced.
    const finalizeCommandRunByRun = (input: {
      readonly runId: number;
      readonly worktreeId: number;
      readonly commandName: string;
      readonly runStatus: TerminalRunStatus;
      readonly stateStatus: CommandStatus;
      readonly runDiagnostic?: CommandRunDiagnosticInput | null | undefined;
    }): Effect.Effect<CommandFinalizeResult, DatabaseError> =>
      Effect.gen(function* () {
        const result = yield* commandRepository.finalizeRunAndStateByRun({
          runId: input.runId,
          worktreeId: input.worktreeId,
          commandName: input.commandName,
          runStatus: input.runStatus,
          stateStatus: input.stateStatus,
          diagnosticReason: input.runDiagnostic?.reason ?? null,
          diagnosticDetail: input.runDiagnostic?.detail ?? null,
        });
        if (result.stateTransitioned) {
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
      finalizeCommandRunByRun,
    });

    // Records that a stop attempt could not establish process control, without
    // claiming the command ended. Re-adoption is the right seam even though the
    // command usually already owns the incarnation: the same call repairs a
    // missing pointer, reopens a run a live process disproves, and writes the
    // diagnostic — atomically, so a partially repaired ownership can never be
    // observed. The publish carries the *unchanged* `running` status because the
    // web's log-metadata invalidation rides `command_changed`; without it a
    // background diagnostic write would stay invisible.
    const recordProcessControlFailure = (input: {
      readonly worktreeId: number;
      readonly commandName: string;
      readonly ptyProcessId: number;
      readonly detail: string;
    }) =>
      Effect.gen(function* () {
        // The repair is authoritative, not best-effort: if it cannot be written
        // there is no diagnostic to find, and swallowing the fault would tell
        // the caller "the stop failed, look at the diagnostic" while nothing was
        // stored. Its `DatabaseError` propagates, and nothing is published,
        // because there is no new metadata to invalidate.
        const readopted = yield* commandRepository.readoptCommandIncarnation({
          worktreeId: input.worktreeId,
          commandName: input.commandName,
          ptyProcessId: input.ptyProcessId,
          diagnostic: { reason: 'process_control_failed', detail: input.detail },
        });
        yield* publishCommandChanged(input.worktreeId, input.commandName, readopted.state.status);
      });

    // A `running` state with no pointer owns a process nothing can currently
    // reach. It is resolved — for every stop origin, explicit Stop and Restart
    // included — through the one place that still knows which incarnation the
    // command meant: its latest run's link.
    //
    // It never fabricates an outcome. `readopted` repairs the pointer and hands
    // the caller back to its ordinary terminate flow, so a dead re-adoptee still
    // reports `already_absent` rather than being stamped `stopped` or
    // `suspended`; `converged` records the incarnation's own terminal fact; and
    // only a genuine dead end — no run, no link, or no such row — becomes
    // `failed`, which is a manufactured status and is reported as such.
    const resolvePointerlessRunningState = (state: CommandStateRow) =>
      Effect.gen(function* () {
        const run = yield* commandRepository.findLatestRun(state);
        const unassociated = (runId: number | null) =>
          Effect.gen(function* () {
            const detail =
              'No process could be associated with this command; it was marked failed.';
            if (runId === null) {
              yield* commandRepository.transitionState({
                worktreeId: state.worktreeId,
                commandName: state.commandName,
                status: 'failed',
                activePtyProcessId: null,
              });
              yield* publishCommandChanged(state.worktreeId, state.commandName, 'failed');
            } else {
              yield* finalizeCommandRunByRun({
                runId,
                worktreeId: state.worktreeId,
                commandName: state.commandName,
                runStatus: 'failed',
                stateStatus: 'failed',
                runDiagnostic: { reason: 'process_control_failed', detail },
              });
            }
            return { resolution: 'unassociated' } as const;
          });

        if (!run) return yield* unassociated(null);
        if (run.ptyProcessId === null) return yield* unassociated(run.id);

        // A read failure is not evidence of absence: propagate it rather than
        // manufacture a dead end for a process that may well be alive.
        const row = yield* ptyRepository.findProcess(run.ptyProcessId);
        if (!row) return yield* unassociated(run.id);

        // Observed after the fact, never during a launch — a persisted `failed`
        // row found here is a failure, not a failed launch.
        const terminal = terminalPtyFactsForRow(row);
        if (terminal) {
          const outcome = terminalCommandOutcomeForPtyRow(terminal, 'event');
          yield* finalizeCommandRunByRun({
            runId: run.id,
            worktreeId: state.worktreeId,
            commandName: state.commandName,
            runStatus: outcome.runStatus,
            stateStatus: outcome.runStatus,
            runDiagnostic: outcome.diagnostic,
          });
          return { resolution: 'converged', status: outcome.runStatus } as const;
        }

        // Nonterminal: re-adopt the incarnation the run itself names. This is
        // the atomic primitive rather than a bare pointer write because
        // ownership has two halves — repairing only the pointer would leave a
        // terminal run under a live process, and the caller's stop would then
        // land its state status over a run that can no longer be completed.
        //
        // No diagnostic: nothing has failed, this is ordinary repair. Nothing
        // published either — the status did not change, and no diagnostic was
        // written for the client to refetch.
        yield* commandRepository.readoptCommandIncarnation({
          worktreeId: state.worktreeId,
          commandName: state.commandName,
          ptyProcessId: run.ptyProcessId,
        });
        return { resolution: 'readopted', ptyProcessId: run.ptyProcessId } as const;
      });

    // The one implementation of the stop matrix. Every stop origin — the API,
    // Restart, the deactivation pass, preDelete, and the delete/prune sweeps —
    // reaches this function with an explicit cause, because the cause is the
    // only thing that distinguishes "the user stopped this" from "Isagi stopped
    // this while leaving the worktree, and intends to bring it back".
    //
    // Suspension is minted at exactly one point below: an affirmative
    // `terminated_live` under cause `deactivation`.
    //
    // The caller holds the command lock.
    const stopResolvedCommand = (
      input: { readonly worktreeId: number; readonly commandName: string },
      state: CommandStateRow | null,
      options: {
        readonly cause: CommandStopCause;
        readonly suppressChangedEvent?: boolean | undefined;
      },
    ): Effect.Effect<CommandStopResult, CommandServiceError> =>
      Effect.gen(function* () {
        if (!state) return { status: 'idle', resolution: 'unchanged' } as const;

        if (state.status === 'suspended') {
          // A repeated deactivation must preserve the intent it created; only a
          // person clears it. No run and no PTY are touched — a suspended
          // command has no live incarnation by construction.
          if (options.cause === 'deactivation') {
            return { status: 'suspended', resolution: 'unchanged' } as const;
          }
          yield* commandRepository.transitionState({
            worktreeId: input.worktreeId,
            commandName: input.commandName,
            status: 'stopped',
            activePtyProcessId: null,
          });
          if (!options.suppressChangedEvent) {
            yield* publishCommandChanged(input.worktreeId, input.commandName, 'stopped');
          }
          return { status: 'stopped', resolution: 'stopped' } as const;
        }

        if (state.status !== 'running') {
          return { status: state.status, resolution: 'unchanged' } as const;
        }

        let ptyProcessId = state.activePtyProcessId;
        if (ptyProcessId === null) {
          const resolved = yield* resolvePointerlessRunningState(state);
          if (resolved.resolution === 'converged') {
            return { status: resolved.status, resolution: 'converged' } as const;
          }
          if (resolved.resolution === 'unassociated') {
            return { status: 'failed', resolution: 'unassociated' } as const;
          }
          ptyProcessId = resolved.ptyProcessId;
        }

        const terminate = yield* pty
          .terminate({ ptyProcessId, gracefulTimeoutMs: commandStopGracefulTimeoutMs })
          .pipe(Effect.either);
        if (Either.isLeft(terminate)) {
          // No terminal evidence at all: the command stays truthfully
          // `running`, carrying a diagnostic that says so, and the failure
          // still reaches the caller — explicit Stop reports it, worktree
          // teardown fails closed, and the deactivation pass logs and continues.
          yield* recordProcessControlFailure({
            worktreeId: input.worktreeId,
            commandName: input.commandName,
            ptyProcessId,
            detail: processControlFailureDetail(
              options.cause,
              describeOperationalCause(terminate.left),
            ),
          }).pipe(
            // The repair failing is the error the caller will see, so the
            // termination failure would otherwise be lost here. It is the only
            // path where that happens.
            Effect.tapError(() =>
              Effect.sync(() => {
                console.warn(
                  `[runtime] Command stop could not record its process-control failure worktree=${input.worktreeId} command=${input.commandName}; original termination failure: ${describeOperationalCause(terminate.left)}`,
                );
              }),
            ),
          );
          return yield* Effect.fail(
            new CommandError({
              code: 'command_action_failed',
              message: `Could not stop command ${input.commandName}.`,
              worktreeId: input.worktreeId,
              commandName: input.commandName,
              cause: terminate.left,
            }),
          );
        }

        // Nothing was there to stop, so this call caused nothing and binds no
        // cause: an independent exit is not a suspension, and a `stopped` that
        // never happened would be a lie. The incarnation's real terminal fact —
        // a captured exit, or the poller's verdict — owns the outcome and
        // reconciles the command when it durably lands.
        if (terminate.right === 'already_absent') {
          return { status: state.status, resolution: 'unchanged' } as const;
        }

        const stateStatus = options.cause === 'deactivation' ? 'suspended' : 'stopped';
        const result = yield* finalizeCommandRunByPty({
          worktreeId: input.worktreeId,
          commandName: input.commandName,
          ptyProcessId,
          runStatus: 'stopped',
          stateStatus,
          publishChange: !options.suppressChangedEvent,
        });
        // The guard rejected the transition (the pointer moved on under a lock
        // we hold — out-of-model), so this attempt changed no entity status and
        // must not be counted as one.
        if (!result.stateTransitioned) {
          return {
            status: result.state?.status ?? state.status,
            resolution: 'unchanged',
          } as const;
        }
        return {
          status: stateStatus,
          resolution: stateStatus === 'suspended' ? 'suspended' : 'stopped',
        } as const;
      });

    // Stop a command the user named: the target is resolved first so an unknown
    // name still fails as `command_not_found`, and the result is shaped as an
    // action output.
    const stopCommand = (
      input: { readonly worktreeId: number; readonly commandName: string },
      options: {
        readonly cause: CommandStopCause;
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
        const result = yield* stopResolvedCommand(input, state, options);
        return commandActionOutput(target, result.status);
      });

    // Stop a command by its durable state alone — no config lookup, no action
    // output. This is the primitive the worktree passes use: the command may
    // have been removed from config, or its config may no longer parse, and the
    // runtime still has to be able to stop the process it owns.
    const stopManagedCommand = (
      input: { readonly worktreeId: number; readonly commandName: string },
      options: { readonly cause: CommandStopCause },
    ) =>
      Effect.gen(function* () {
        const state = yield* commandRepository.findState(input);
        return yield* stopResolvedCommand(input, state, options);
      });

    // Boot convergence and the deletion audit share one process-accounting
    // module; the layer keeps ownership of the lock, the bus, and the finalizer
    // it hands them.
    const convergenceDependencies: CommandConvergenceDependencies = {
      commandRepository,
      ptyRepository,
      pty,
      publishCommandChanged,
      finalizeCommandRunByRun,
      withLock: (target, effect) => withCommandLock(locks, target, effect),
    };

    // The worktree-level passes — postCreate, deactivation, activation,
    // preDelete, and the teardown sweep — live in `commands.lifecycle.ts`. They
    // receive the capabilities they need rather than resolving anything of their
    // own, so this layer stays the sole owner of the lock registry and the bus.
    const lifecycle = makeCommandLifecycle({
      workspaceRepository,
      commandRepository,
      runCommand,
      stopCommand,
      stopManagedCommand,
      cleanupIncarnations: (input) => cleanupCommandIncarnations(convergenceDependencies, input),
      withLock: (target, effect) => withCommandLock(locks, target, effect),
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

    // Startup process accounting. Runs here — after the PTY layer's own startup
    // reconciliation, before the event subscriber and startup activation exist —
    // because every conclusion it draws about a command depends on first
    // establishing what happened to that command's processes. It is a
    // construction-time internal with no production caller outside this block.
    yield* reconcileCommandsAtBoot(convergenceDependencies).pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => {
          console.warn(
            `[runtime] Command boot convergence failed cause=${describeOperationalCause(error)}`,
          );
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
        console.warn(
          `[runtime] Command process event reconciliation failed cause=${describeOperationalCause(error)}`,
        );
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
            yield* lifecycle
              .applyActivationLifecycle({
                previousWorktreeId: event.previousWorktreeId,
                nextWorktreeId: event.nextWorktreeId,
                cause: event.cause,
              })
              .pipe(Effect.catchAll(logEventError));
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
      stop: (input) => withCommandLock(locks, input, stopCommand(input, { cause: 'user' })),
      restart: (input) =>
        withCommandLock(
          locks,
          input,
          stopCommand(input, { cause: 'user', suppressChangedEvent: true }).pipe(
            Effect.zipRight(runCommand(input)),
          ),
        ),
      runPostCreateLifecycle: (input) => lifecycle.runPostCreateLifecycle(input.worktreeId),
      cleanupBeforeWorktreeDelete: (input) =>
        Effect.gen(function* () {
          yield* lifecycle.stopPreDeleteCommands(input.worktreeId);
          yield* lifecycle.stopAllManagedCommands(input.worktreeId);
          // Stops act on what the runtime believes; the audit acts on what the
          // database still points at. Only the second can conclude that no
          // observable process survives the cascade.
          yield* lifecycle.auditWorktreeCommandIncarnations(input.worktreeId);
        }),
      cleanupBeforeWorktreePrune: (input) =>
        Effect.gen(function* () {
          yield* lifecycle.stopAllManagedCommands(input.worktreeId);
          yield* lifecycle.auditWorktreeCommandIncarnations(input.worktreeId);
        }),
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

// Which durable states keep a command visible in the removed/managed
// projections. `suspended` belongs here: it is an intent the user can act on —
// resume it, or clear it with Stop — and hiding it would make a command that is
// waiting to come back look like one that is gone.
function commandStatesNeedingAttention(states: readonly CommandStateRow[]): CommandSummary[] {
  return states
    .filter(
      (state) =>
        state.status === 'running' || state.status === 'failed' || state.status === 'suspended',
    )
    .map((state) => ({
      name: state.commandName,
      status: state.status,
      ports: [],
    }));
}

// Runtime-authored diagnostic detail, chosen by why the stop happened: a user
// who pressed Stop already knows what they asked for, while a command stopped by
// a worktree switch has to say so or the diagnostic reads as an unexplained
// failure. `CommandStopCause` decides only this and the suspension question —
// the deletion audit writes its own cleanup-specific wording at its own call
// site rather than widening the cause.
function processControlFailureDetail(cause: CommandStopCause, message: string) {
  return cause === 'deactivation'
    ? `Could not stop the process while leaving the worktree: ${message}`
    : `Could not stop the process: ${message}`;
}
