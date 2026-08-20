import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

import { Effect, Either } from 'effect';

import type { CommandRunDiagnosticReason, CommandStatus } from '@isagi/contracts';

import { DatabaseError } from '../persistence/index.js';
import type { WorktreeCommandConfig } from '../project-config/project-config.schema.js';
import type {
  PtyProcessAllocation,
  PtyRepositoryService,
  PtyServiceShape,
} from '../pty-processes/index.js';
import type { WorkspaceRepositoryService } from '../workspace/index.js';
import {
  terminalCommandOutcomeForPtyRow,
  terminalPtyFactsForRow,
  type CommandRunDiagnosticInput,
  type TerminalCommandOutcome,
  type TerminalRunStatus,
} from './commands.outcomes.js';
import type { CommandRepositoryService } from './commands.repository.js';
import { actionOutput, resolveConfiguredCommand, type CommandTarget } from './commands.targets.js';
import { parseDotenv } from './dotenv.js';

// Keep only the newest run per command. Each retained run pins a PTY row + log
// for GC, and only the latest run is ever read, so one is the right bound.
const latestCommandRunsToRetain = 1;

export interface CommandLauncherDependencies {
  readonly workspaceRepository: WorkspaceRepositoryService;
  readonly commandRepository: CommandRepositoryService;
  readonly ptyRepository: PtyRepositoryService;
  readonly pty: PtyServiceShape;
  readonly publishCommandChanged: (
    worktreeId: number,
    commandName: string,
    status: CommandStatus,
  ) => Effect.Effect<void>;
}

// The command launch flow, extracted from the service layer so one launch can be
// read end to end. The caller holds the command lock for the (worktreeId,
// commandName) being launched.
export function makeCommandLauncher(deps: CommandLauncherDependencies) {
  const { workspaceRepository, commandRepository, ptyRepository, pty, publishCommandChanged } =
    deps;

  // The launch flow's finalizer. Keyed by the run rather than the incarnation
  // because the state's pointer is still null there — it is the
  // launch-in-progress marker — so no pointer guard could ever match, and a
  // two-step complete-then-transition would leave a terminal run under a
  // `running` state that nothing could later repair.
  const finalizeCommandRunByRun = (input: {
    readonly runId: number;
    readonly worktreeId: number;
    readonly commandName: string;
    readonly runStatus: TerminalRunStatus;
    readonly stateStatus: CommandStatus;
    readonly runDiagnostic?: CommandRunDiagnosticInput | null | undefined;
  }) =>
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

  // Launch with ownership before spawn. The durable order is: create the run,
  // write the launch-in-progress marker, allocate (and reserve) the PTY row,
  // persist the run→PTY link, and only then start a backend process. A command
  // process therefore cannot exist before the row that owns it, which is what
  // makes every later observer — events, the poller, boot, deletion — able to
  // find the command an incarnation belongs to.
  //
  // From the moment `createRun` returns, every exit path either completes that
  // run or hands it to a named recovery; none may leave it silently `running`.
  const runCommand = (input: { readonly worktreeId: number; readonly commandName: string }) =>
    Effect.gen(function* () {
      const target = yield* resolveConfiguredCommand(workspaceRepository, input);
      const current = yield* commandRepository.findState(input);
      if (current?.status === 'running') {
        return actionOutput(target.command, current.status, target.worktree.id);
      }

      const worktreeId = target.worktree.id;
      const commandName = target.command.name;

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
        worktreeId,
        commandName,
        status: 'running',
      });

      // Handoff facts the interruption finalizer below reads. They are plain
      // mutable locals because the finalizer runs inside this same still-held
      // command lock, after this fiber has stopped executing.
      let allocation: PtyProcessAllocation | null = null;
      let linked = false;

      const converge = (outcome: TerminalCommandOutcome) =>
        finalizeCommandRunByRun({
          runId: run.id,
          worktreeId,
          commandName,
          runStatus: outcome.runStatus,
          stateStatus: outcome.runStatus,
          runDiagnostic: outcome.diagnostic,
        });

      const launchFailure = (detail: string): TerminalCommandOutcome => ({
        runStatus: 'failed',
        diagnostic: { reason: 'pty_launch_failed', detail },
      });

      // Before the marker exists there is no `running` state to converge, and
      // the prior entity status must survive untouched — a resume's
      // `suspended` intent has to remain armed for the next activation. So only
      // the run is completed, and the unchanged status is republished purely so
      // the client refetches the metadata carrying the new diagnostic.
      const convergeBeforeMarker = (error: DatabaseError, detail: string) =>
        Effect.gen(function* () {
          const completed = yield* commandRepository
            .completeRun({
              runId: run.id,
              status: 'failed',
              diagnosticReason: 'pty_launch_failed',
              diagnosticDetail: detail,
            })
            .pipe(Effect.either);
          if (Either.isRight(completed) && completed.right) {
            yield* publishCommandChanged(worktreeId, commandName, current?.status ?? 'idle');
          } else {
            // Nothing was written, so there is no new metadata to invalidate
            // and publishing would announce a diagnostic that does not exist.
            // The linkless running run is bounded by the next launch's prune
            // and by boot reconciliation.
            console.warn(
              `[runtime] Command launch could not record its failure diagnostic worktree=${worktreeId} command=${commandName}`,
              Either.isLeft(completed) ? completed.left : 'run row missing',
            );
          }
          return yield* Effect.fail(error);
        });

      // Cancellation between here and a completed handoff would otherwise
      // strand a `running` state with a null pointer, which no PTY event could
      // ever repair — the pointer guard cannot match null. Best-effort, and
      // uninterruptible by construction: `onInterrupt` finalizers are not
      // themselves interruptible.
      const interruptionFinalizer = Effect.gen(function* () {
        if (allocation) yield* allocation.abandon;
        if (!allocation || !linked) {
          yield* converge(
            launchFailure('The launch was cancelled before the command process started.'),
          );
          return;
        }
        // Only a successful read carrying terminal facts may converge: an
        // unreadable row says nothing about the process, and assuming it died
        // would abandon a possibly-live incarnation under a null pointer.
        // Both a nonterminal row and a failed read therefore fall through to
        // ownership.
        const row = yield* ptyRepository.findProcess(allocation.ptyProcessId).pipe(Effect.either);
        const terminal = Either.isRight(row) ? terminalPtyFactsForRow(row.right) : null;
        if (terminal) {
          yield* converge(terminalCommandOutcomeForPtyRow(terminal, 'launch'));
          return;
        }
        // The process is owned, live-or-pending, and nobody is waiting on this
        // call any more. Install the pointer so the incarnation is stoppable
        // and its eventual event converges the command, and publish — the
        // cancelled request returned nothing and the marker published nothing,
        // so this is the only announcement the client will get.
        yield* commandRepository.transitionState({
          worktreeId,
          commandName,
          status: 'running',
          activePtyProcessId: allocation.ptyProcessId,
        });
        yield* publishCommandChanged(worktreeId, commandName, 'running');
      }).pipe(
        Effect.catchAll((error) =>
          Effect.sync(() => {
            console.warn(
              `[runtime] Command launch interruption recovery failed worktree=${worktreeId} command=${commandName}`,
              error,
            );
          }),
        ),
      );

      return yield* Effect.gen(function* () {
        const pruned = yield* pruneCommandRunHistory(commandRepository, {
          worktreeId,
          commandName,
        }).pipe(Effect.either);
        if (Either.isLeft(pruned)) {
          return yield* convergeBeforeMarker(
            pruned.left,
            `Could not prepare the launch: ${diagnosticDetailForCause(pruned.left)}`,
          );
        }

        // The durable launch-in-progress marker: a `running` state with no
        // pointer yet. It exists before any incarnation does, so boot's
        // running-state scan covers every crash window. It publishes nothing —
        // the handoff below announces the real outcome.
        const marker = yield* commandRepository
          .transitionState({
            worktreeId,
            commandName,
            status: 'running',
            activePtyProcessId: null,
          })
          .pipe(Effect.either);
        if (Either.isLeft(marker)) {
          return yield* convergeBeforeMarker(
            marker.left,
            `Could not record the launch: ${diagnosticDetailForCause(marker.left)}`,
          );
        }

        const shell = process.env.SHELL && process.env.SHELL.trim() ? process.env.SHELL : '/bin/sh';
        return yield* Effect.scoped(
          Effect.gen(function* () {
            // The scoped releaser abandons an allocation that never started —
            // including one interrupted between acquisition and `start` — and
            // is a no-op once `start` has begun.
            const acquired = yield* Effect.acquireRelease(
              pty.allocateLaunch({
                command: shell,
                args: ['-lc', target.command.command],
                cwd,
                envOverrides: envResult.right,
                shellIntegration: false,
              }),
              (candidate) => candidate.abandon,
            ).pipe(Effect.either);
            if (Either.isLeft(acquired)) {
              yield* converge(launchFailure(diagnosticDetailForCause(acquired.left)));
              return actionOutput(target.command, 'failed', worktreeId);
            }
            const acquiredAllocation = acquired.right;
            allocation = acquiredAllocation;

            // The ownership link, written before any process exists.
            const link = yield* commandRepository
              .updateRunPty({ runId: run.id, ptyProcessId: acquiredAllocation.ptyProcessId })
              .pipe(Effect.either);
            if (Either.isLeft(link)) {
              yield* acquiredAllocation.abandon;
              const converged = yield* converge(
                launchFailure(
                  `Could not record the process association; the command was not started: ${diagnosticDetailForCause(link.left)}`,
                ),
              ).pipe(Effect.either);
              // Only when the convergence write also fails does the original
              // fault propagate, leaving the residue boot resolves.
              if (Either.isLeft(converged)) return yield* Effect.fail(link.left);
              return actionOutput(target.command, 'failed', worktreeId);
            }
            if (!link.right) {
              // The run was created moments ago inside this held lock, so it
              // cannot legitimately be gone. Reporting an ordinary `failed`
              // action here would claim a diagnostic that has no row to live
              // on and send the user looking for it.
              return yield* Effect.die(
                new Error(
                  `Command run ${run.id} vanished while linking PTY process ${acquiredAllocation.ptyProcessId} (worktree ${worktreeId}, command ${commandName}).`,
                ),
              );
            }
            linked = true;

            // Total once it completes uninterrupted: a launch failure is folded
            // into the row rather than raised, so the row — not a result — is
            // what distinguishes success from failure.
            yield* acquiredAllocation.start;

            // Same asymmetry as the interruption finalizer: the process has
            // started, so only a successful read carrying terminal facts may
            // end the command here. An unreadable row leaves ownership to be
            // installed below, where the poller and the incarnation's own
            // event can still converge it.
            const startedRow = yield* ptyRepository
              .findProcess(acquiredAllocation.ptyProcessId)
              .pipe(Effect.either);
            const terminal = Either.isRight(startedRow)
              ? terminalPtyFactsForRow(startedRow.right)
              : null;
            if (terminal) {
              const outcome = terminalCommandOutcomeForPtyRow(terminal, 'launch');
              yield* converge(outcome);
              return actionOutput(target.command, outcome.runStatus, worktreeId);
            }

            // `running`, or still `starting` because a post-launch persistence
            // fault left the transition to the poller. Either way the command
            // owns the incarnation and the row heals itself.
            yield* commandRepository.transitionState({
              worktreeId,
              commandName,
              status: 'running',
              activePtyProcessId: acquiredAllocation.ptyProcessId,
            });
            yield* publishCommandChanged(worktreeId, commandName, 'running');
            return actionOutput(target.command, 'running', worktreeId);
          }),
        );
      }).pipe(Effect.onInterrupt(() => interruptionFinalizer));
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

  return { runCommand } as const;
}

// Returns only the configured overrides (env files, then command `env`). The PTY
// layer supplies the login-shell baseline, so premerging `process.env` here would
// both duplicate that baseline and expose the runtime's own controls to commands.
function buildCommandEnv(worktreeRoot: string, command: WorktreeCommandConfig) {
  return Effect.gen(function* () {
    const env: NodeJS.ProcessEnv = {};
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
  // `DatabaseError` is the launch path's only expected failure now that a
  // started launch is total, and it carries its context in `operation`/`cause`
  // rather than in `message` — reading `message` alone would show the user an
  // empty diagnostic for a real persistence fault.
  if (cause instanceof DatabaseError) {
    return `Database operation ${cause.operation} failed: ${describeCause(cause.cause)}`;
  }
  return describeCause(cause);
}

function describeCause(cause: unknown) {
  if (cause instanceof Error && cause.message) return cause.message;
  return String(cause);
}
