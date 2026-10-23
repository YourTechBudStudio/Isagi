import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

import { Data, Effect, Result } from 'effect';

import type { CommandRunDiagnosticReason, CommandStatus } from '@isagi/contracts';

import { describeOperationalCause } from '../platform/diagnostics/index.js';
import type { LoopbackPortProbe } from '../platform/net/index.js';
import type { DatabaseError } from '../platform/persistence/index.js';
import type { WorktreeCommandConfig, ProjectRepository } from '../projects/index.js';
import type { PtyProcessAllocation, PtyService } from '../pty-processes/index.js';
import { parseDotenv } from './dotenv.js';
import {
  terminalCommandOutcomeForPtyRow,
  terminalPtyFactsForRow,
  type CommandRunDiagnosticInput,
  type TerminalCommandOutcome,
  type TerminalRunStatus,
} from './outcomes.js';
import { portEnvInjections, resolveCommandPorts } from './ports.js';
import type { CommandFinalizeResult, CommandRepository } from './repository.js';
import { actionOutput, resolveConfiguredCommand, type CommandTarget } from './targets.js';

// Keep only the newest run per command. Each retained run pins a PTY row + log
// for GC, and only the latest run is ever read, so one is the right bound.
const latestCommandRunsToRetain = 1;

export interface CommandLauncherDependencies {
  readonly projectRepository: ProjectRepository['Service'];
  readonly commandRepository: CommandRepository['Service'];
  readonly pty: PtyService['Service'];
  // The loopback probe the endpoint resolution stage runs on. Injected rather
  // than imported so lifecycle tests can prove a launch either did or did not
  // perform socket IO.
  readonly portProbe: LoopbackPortProbe['Service'];
  readonly publishCommandChanged: (
    worktreeId: number,
    commandName: string,
    status: CommandStatus,
  ) => Effect.Effect<void>;
  // The run-keyed finalizer, owned by the service layer because pointerless
  // recovery uses the same seam. Keyed by the run rather than the incarnation
  // because the state's pointer is still null during a launch — it is the
  // launch-in-progress marker — so no pointer guard could ever match, and a
  // two-step complete-then-transition would leave a terminal run under a
  // `running` state that nothing could later repair.
  readonly finalizeCommandRunByRun: (input: {
    readonly runId: number;
    readonly worktreeId: number;
    readonly commandName: string;
    readonly runStatus: TerminalRunStatus;
    readonly stateStatus: CommandStatus;
    readonly runDiagnostic?: CommandRunDiagnosticInput | null | undefined;
  }) => Effect.Effect<CommandFinalizeResult, DatabaseError>;
}

// The command launch flow, extracted from the service layer so one launch can be
// read end to end. The caller holds the command lock for the (worktreeId,
// commandName) being launched.
export function makeCommandLauncher(deps: CommandLauncherDependencies) {
  const {
    projectRepository,
    commandRepository,
    pty,
    portProbe,
    publishCommandChanged,
    finalizeCommandRunByRun,
  } = deps;

  // Launch with ownership before spawn. The durable order is: create the run,
  // write the launch-in-progress marker, allocate (and reserve) the PTY row,
  // persist the run→PTY link, and only then start a backend process. A command
  // process therefore cannot exist before the row that owns it, which is what
  // makes every later observer — events, the poller, boot, deletion — able to
  // find the command an incarnation belongs to.
  //
  // From the moment `createRun` returns, every exit path either completes that
  // run or hands it to a named recovery; none may leave it silently `running`.
  const runCommand = Effect.fn('commands.launch')(function* (input: {
    readonly worktreeId: number;
    readonly commandName: string;
  }) {
    const target = yield* resolveConfiguredCommand(projectRepository, input);
    const current = yield* commandRepository.findState(input);
    if (current?.status === 'running') {
      return actionOutput(
        target.command,
        current.status,
        target.worktree.id,
        current.resolvedPorts,
      );
    }

    const worktreeId = target.worktree.id;
    const commandName = target.command.name;

    const cwd = resolve(target.worktree.path, target.command.cwd ?? '.');
    if (!directoryExists(cwd)) {
      return yield* failedRun(target, 'missing_cwd', target.command.cwd ?? '.');
    }

    // Endpoint resolution, before the marker and before any incarnation
    // exists. It deliberately precedes environment composition so the stage
    // order matches the one the architecture fixed. An expected failure here
    // is an ordinary failed launch: `failedRun` records a completed failed run
    // carrying the diagnostic, exactly as `missing_cwd` and `env_invalid` do.
    // `Effect.result` narrows to the resolver's single expected failure — a
    // defect stays a defect and an interrupt still interrupts, and neither
    // reaches the marker, so the previous snapshot survives all three.
    const resolution = yield* resolveCommandPorts({
      declared: target.command.ports,
      // The preference is the last successfully established resolution. It is
      // already in hand from the running check above, so resolution costs no
      // extra read.
      remembered: current?.resolvedPorts ?? null,
      probe: portProbe,
    }).pipe(Effect.result);
    if (Result.isFailure(resolution)) {
      return yield* failedRun(target, 'port_allocation_failed', resolution.failure.detail);
    }
    const resolved = resolution.success;

    const envResult = yield* buildCommandEnv(target.worktree.path, target.command).pipe(
      Effect.result,
    );
    if (Result.isFailure(envResult)) {
      return yield* failedRun(target, 'env_invalid', envResult.failure.message);
    }

    // The top of the precedence ladder. The PTY layer supplies the login-shell
    // baseline below `buildCommandEnv`'s `envFiles`-then-`env` result, and the
    // allocated values sit above all of it: a command must see the port value
    // the runtime resolved and injected, whatever a checked-in env file says.
    // Nothing is reserved — the port is not held between resolution and the
    // command's own bind — so this is the value the command is asked to take,
    // not a promise that it is free. A collision with the command's explicit
    // `env` is impossible (config validation rejects it), so the only value
    // this can shadow is one from an env file, which is the documented
    // precedence.
    const launchEnv: NodeJS.ProcessEnv = {
      ...envResult.success,
      ...portEnvInjections(resolved),
    };

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
        stateStatus: outcome.stateStatus,
        runDiagnostic: outcome.diagnostic,
      });

    const launchFailure = (detail: string): TerminalCommandOutcome => ({
      runStatus: 'failed',
      stateStatus: 'failed',
      diagnostic: { reason: 'pty_launch_failed', detail },
    });

    // Before the marker exists there is no `running` state to converge, and
    // the prior entity status must survive untouched — a resume's
    // `suspended` intent has to remain armed for the next activation. So only
    // the run is completed, and the unchanged status is republished purely so
    // the client refetches the metadata carrying the new diagnostic.
    const convergeBeforeMarker = Effect.fnUntraced(function* (
      error: DatabaseError,
      detail: string,
    ) {
      const completed = yield* commandRepository
        .completeRun({
          runId: run.id,
          status: 'failed',
          diagnosticReason: 'pty_launch_failed',
          diagnosticDetail: detail,
        })
        .pipe(Effect.result);
      if (Result.isSuccess(completed) && completed.success) {
        yield* publishCommandChanged(worktreeId, commandName, current?.status ?? 'idle');
      } else {
        // Nothing was written, so there is no new metadata to invalidate
        // and publishing would announce a diagnostic that does not exist.
        // The linkless running run is bounded by the next launch's prune
        // and by boot reconciliation.
        yield* Effect.logWarning('Command launch could not record its failure diagnostic').pipe(
          Effect.annotateLogs({
            worktreeId,
            commandName,
            cause: Result.isFailure(completed)
              ? describeOperationalCause(completed.failure)
              : 'run row missing',
          }),
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
      const row = yield* pty.findProcess(allocation.ptyProcessId).pipe(Effect.result);
      const terminal = Result.isSuccess(row) ? terminalPtyFactsForRow(row.success) : null;
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
      Effect.catch((error) =>
        Effect.logWarning('Command launch interruption recovery failed').pipe(
          Effect.annotateLogs({
            worktreeId,
            commandName,
            cause: describeOperationalCause(error),
          }),
        ),
      ),
    );

    return yield* Effect.gen(function* () {
      const pruned = yield* pruneCommandRunHistory(commandRepository, {
        worktreeId,
        commandName,
      }).pipe(Effect.result);
      if (Result.isFailure(pruned)) {
        return yield* convergeBeforeMarker(
          pruned.failure,
          `Could not prepare the launch: ${describeOperationalCause(pruned.failure)}`,
        );
      }

      // The durable launch-in-progress marker: a `running` state with no
      // pointer yet. It exists before any incarnation does, so boot's
      // running-state scan covers every crash window. It publishes nothing —
      // the handoff below announces the real outcome.
      // The marker is also the *only* writer of the resolved snapshot, which
      // makes it the supersession boundary: everything before it preserves the
      // previous resolution, everything after it belongs to this incarnation.
      // A command that declares no ports resolves to `[]` and supersedes with
      // `[]` — there is no "nothing to write, so skip it" case, because
      // forgetting to forget is how stale memory survives a config edit.
      const marker = yield* commandRepository
        .markLaunchInProgress({ worktreeId, commandName, resolvedPorts: resolved })
        .pipe(Effect.result);
      if (Result.isFailure(marker)) {
        return yield* convergeBeforeMarker(
          marker.failure,
          `Could not record the launch: ${describeOperationalCause(marker.failure)}`,
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
              envOverrides: launchEnv,
              shellIntegration: false,
            }),
            (candidate) => candidate.abandon,
          ).pipe(Effect.result);
          if (Result.isFailure(acquired)) {
            yield* converge(launchFailure(describeOperationalCause(acquired.failure)));
            return actionOutput(target.command, 'failed', worktreeId, null);
          }
          const acquiredAllocation = acquired.success;
          allocation = acquiredAllocation;

          // The ownership link, written before any process exists.
          const link = yield* commandRepository
            .updateRunPty({ runId: run.id, ptyProcessId: acquiredAllocation.ptyProcessId })
            .pipe(Effect.result);
          if (Result.isFailure(link)) {
            yield* acquiredAllocation.abandon;
            const converged = yield* converge(
              launchFailure(
                `Could not record the process association; the command was not started: ${describeOperationalCause(link.failure)}`,
              ),
            ).pipe(Effect.result);
            // Only when the convergence write also fails does the original
            // fault propagate, leaving the residue boot resolves.
            if (Result.isFailure(converged)) return yield* Effect.fail(link.failure);
            return actionOutput(target.command, 'failed', worktreeId, null);
          }
          if (!link.success) {
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
          const startedRow = yield* pty
            .findProcess(acquiredAllocation.ptyProcessId)
            .pipe(Effect.result);
          const terminal = Result.isSuccess(startedRow)
            ? terminalPtyFactsForRow(startedRow.success)
            : null;
          if (terminal) {
            const outcome = terminalCommandOutcomeForPtyRow(terminal, 'launch');
            yield* converge(outcome);
            return actionOutput(target.command, outcome.stateStatus, worktreeId, null);
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
          // The resolution this launch established, not a re-read: the caller
          // is told exactly what the process it just started received.
          return actionOutput(target.command, 'running', worktreeId, resolved);
        }),
      );
    }).pipe(Effect.onInterrupt(() => interruptionFinalizer));
  });

  const failedRun = Effect.fnUntraced(function* (
    target: CommandTarget,
    diagnosticReason: CommandRunDiagnosticReason,
    diagnosticDetail: string,
  ) {
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
    return actionOutput(target.command, 'failed', target.worktree.id, null);
  });

  return { runCommand } as const;
}

// Why a command's environment could not be composed. `message` is runtime-authored
// and becomes the run's `env_invalid` diagnostic detail.
class CommandEnvInvalid extends Data.TaggedError('CommandEnvInvalid')<{
  readonly message: string;
}> {}

// Returns only the configured overrides (env files, then command `env`). The PTY
// layer supplies the login-shell baseline, so premerging `process.env` here would
// both duplicate that baseline and expose the runtime's own controls to commands.
const buildCommandEnv = Effect.fnUntraced(function* (
  worktreeRoot: string,
  command: WorktreeCommandConfig,
): Effect.fn.Return<NodeJS.ProcessEnv, CommandEnvInvalid> {
  const env: NodeJS.ProcessEnv = {};
  for (const envFile of command.envFiles) {
    const path = resolve(worktreeRoot, envFile);
    if (!existsSync(path)) {
      return yield* new CommandEnvInvalid({ message: `Missing env file: ${envFile}` });
    }
    const contents = yield* Effect.tryPromise({
      try: () => readFile(path, 'utf8'),
      catch: (cause) =>
        new CommandEnvInvalid({
          message: `Could not read env file ${envFile}: ${String(cause)}`,
        }),
    });
    Object.assign(env, parseDotenv(contents));
  }
  Object.assign(env, command.env);
  return env;
});

function directoryExists(path: string) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function pruneCommandRunHistory(
  commandRepository: CommandRepository['Service'],
  input: { readonly worktreeId: number; readonly commandName: string },
) {
  return commandRepository
    .pruneRunHistory({
      ...input,
      keep: latestCommandRunsToRetain,
    })
    .pipe(Effect.asVoid);
}
