import { Effect, Result } from 'effect';

import type { CommandStatus } from '@isagi/contracts';

import { describeOperationalCause } from '../platform/diagnostics/index.js';
import type { DatabaseError } from '../platform/persistence/index.js';
import type { DurablePtyTerminationReason, PtyService } from '../pty-processes/index.js';
import {
  commandStateForCompletedRun,
  runtimeInterruptedCommandOutcome,
  terminalCommandOutcomeForPtyRow,
  terminalPtyFactsForRow,
  type CommandRunDiagnosticInput,
} from './outcomes.js';
import type {
  CommandFinalizeResult,
  CommandPtyLink,
  CommandStateRow,
  CommandRepository,
} from './repository.js';

// Process accounting for durable command ownership.
//
// Two callers reconcile a command against the processes it still refers to: the
// runtime starting up, and a worktree being deleted. Both have to establish
// what actually happened to each incarnation *before* writing anything about
// the command, because the alternative — trusting a status row about a process
// nobody looked at — is how a live process gets abandoned or a healthy one gets
// declared dead.
//
// The shared half is deliberately only the nonterminal one. A terminal row that
// failed its backend-absence check is a deletion gate, not a repair candidate:
// its command already recorded how that incarnation ended, and re-opening it as
// `running` would manufacture liveness out of an unverifiable negative.

export interface CommandConvergenceDependencies {
  readonly commandRepository: CommandRepository['Service'];
  readonly pty: PtyService['Service'];
  readonly publishCommandChanged: (
    worktreeId: number,
    commandName: string,
    status: CommandStatus,
  ) => Effect.Effect<void>;
  // The run-keyed atomic finalizer, owned by the service layer.
  readonly finalizeCommandRunByRun: (input: {
    readonly runId: number;
    readonly worktreeId: number;
    readonly commandName: string;
    readonly runStatus: 'exited' | 'stopped' | 'failed';
    readonly stateStatus: CommandStatus;
    readonly runDiagnostic?: CommandRunDiagnosticInput | null | undefined;
  }) => Effect.Effect<CommandFinalizeResult, DatabaseError>;
  readonly withLock: <A, E, R>(
    input: { readonly worktreeId: number; readonly commandName: string },
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

export interface CommandTarget {
  readonly worktreeId: number;
  readonly commandName: string;
}

// Why a cleanup attempt's failure could not be repaired away, decided from a
// **fresh** read of the row taken after the attempt failed rather than from
// whatever the caller believed before it started.
export type CommandCleanupFailureKind =
  // Still nonterminal: something may well be alive out there, and the command
  // should go on owning it. The one repair candidate.
  | 'unresolved'
  // Terminal row whose gating backend-absence check failed. Deletion must not
  // proceed, but the command's own record is already true and is left alone.
  | 'terminal_gated'
  // The classifying read itself failed, or the row vanished. No conclusion is
  // available, so the conservative one is taken: gate, never repair.
  | 'unclassified';

export interface CommandCleanupFailure {
  readonly ptyProcessId: number;
  readonly kind: CommandCleanupFailureKind;
  // Which transport could not be verified, taken from the same fresh read that
  // decided the classification. This is the first thing a maintainer needs in
  // order to tell "tmux is uninstalled" from "this ref is corrupt" — and for a
  // `terminal_gated` failure the log is the *only* artifact that carries it,
  // because nothing is written to any command row.
  readonly backend: string | null;
  readonly error: unknown;
}

export interface CommandCleanupResult {
  // Every failure, in candidate order. A caller that gates on cleanup uses this
  // and nothing else; the classification below only decides repair.
  readonly failures: readonly CommandCleanupFailure[];
  readonly readoptedPtyProcessId: number | null;
}

/**
 * Clean up every incarnation one command still refers to, then repair ownership
 * if — and only if — the cleanup left exactly one failure in total and that
 * failure is a nonterminal, still-unresolved incarnation.
 *
 * The caller holds the command's lock.
 *
 * Each candidate is attempted exactly once. Failures are collected rather than
 * short-circuited, because a caller that stops at the first failure would leave
 * later incarnations un-audited and then report a cleanup it never finished.
 */
export const cleanupCommandIncarnations = Effect.fnUntraced(function* (
  deps: CommandConvergenceDependencies,
  input: {
    readonly target: CommandTarget;
    readonly candidates: readonly number[];
    readonly reason: DurablePtyTerminationReason;
    readonly ensureBackendAbsence: boolean;
    // Names the operation in the durable diagnostic a re-adoption writes, so a
    // user reading it later knows whether the runtime restarted or a worktree
    // delete was refused.
    readonly readoptDetail: (message: string) => string;
    readonly operation: string;
  },
): Effect.fn.Return<CommandCleanupResult, DatabaseError> {
  const failures: CommandCleanupFailure[] = [];

  for (const ptyProcessId of input.candidates) {
    const outcome = yield* deps.pty
      .cleanupProcess({
        ptyProcessId,
        reason: input.reason,
        ensureBackendAbsence: input.ensureBackendAbsence,
      })
      .pipe(Effect.result);
    if (Result.isSuccess(outcome)) continue;

    // Classify from the row as it stands *now*. Doing this before the attempt
    // would misread a row that went terminal in between: the gating kill
    // would be skipped on one side, and a terminal incarnation would become a
    // repair candidate on the other.
    const classified = yield* classifyCleanupFailure(deps.pty, ptyProcessId);
    failures.push({ ptyProcessId, error: outcome.failure, ...classified });
    yield* Effect.logWarning('Command incarnation cleanup failed').pipe(
      Effect.annotateLogs({
        operation: input.operation,
        worktreeId: input.target.worktreeId,
        commandName: input.target.commandName,
        ptyProcessId,
        backend: classified.backend ?? 'unknown',
        classification: classified.kind,
        cause: describeOperationalCause(outcome.failure),
      }),
    );
  }

  const unresolved = failures.filter((failure) => failure.kind === 'unresolved');
  if (unresolved.length === 0) {
    return { failures, readoptedPtyProcessId: null } as const;
  }

  if (failures.length > 1) {
    // Out-of-model divergence: more than one incarnation could not be
    // resolved. Re-adoption binds the command to exactly one — it repoints
    // the state *and* rewrites the retained run's link — so repairing here
    // would erase the last durable link to the others. That is true whatever
    // the other failures were classified as: a `terminal_gated` or
    // `unclassified` incarnation still has a backend session nobody could
    // verify, and losing its link means the next audit cannot rediscover it
    // and may let the worktree cascade while it is still alive. Drain what
    // can be drained, keep every link, and let the next boot or delete retry.
    yield* Effect.logError(
      'Command has multiple unrepairable incarnations and was left unrepaired',
    ).pipe(
      Effect.annotateLogs({
        operation: input.operation,
        worktreeId: input.target.worktreeId,
        commandName: input.target.commandName,
        incarnations: failures
          .map(
            (failure) => `${failure.ptyProcessId}/${failure.backend ?? 'unknown'}/${failure.kind}`,
          )
          .join(','),
      }),
    );
    return { failures, readoptedPtyProcessId: null } as const;
  }

  // Exactly one failure overall, and it is the unresolved one. Take honest
  // ownership of it: one transaction repoints the state, reopens the retained
  // run against the same incarnation, and records why the command is degraded
  // — so the user can see it and retry the stop through the ordinary path.
  const survivor = unresolved[0];
  if (!survivor) return { failures, readoptedPtyProcessId: null } as const;
  const readopted = yield* deps.commandRepository.readoptCommandIncarnation({
    worktreeId: input.target.worktreeId,
    commandName: input.target.commandName,
    ptyProcessId: survivor.ptyProcessId,
    diagnostic: {
      reason: 'process_control_failed',
      detail: input.readoptDetail(describeOperationalCause(survivor.error)),
    },
  });
  // Always published, even though the status did not change: the web client's
  // log-metadata invalidation rides `command_changed`, so a background
  // diagnostic write is invisible without it. This matters most for the
  // deletion audit, which runs while clients are connected and watching.
  yield* deps.publishCommandChanged(
    input.target.worktreeId,
    input.target.commandName,
    readopted.state.status,
  );
  yield* Effect.logWarning('Command re-adopted an unresolved incarnation').pipe(
    Effect.annotateLogs({
      operation: input.operation,
      worktreeId: input.target.worktreeId,
      commandName: input.target.commandName,
      ptyProcessId: survivor.ptyProcessId,
      backend: survivor.backend ?? 'unknown',
    }),
  );
  return { failures, readoptedPtyProcessId: survivor.ptyProcessId } as const;
});

function classifyCleanupFailure(
  pty: Pick<PtyService['Service'], 'findProcess'>,
  ptyProcessId: number,
): Effect.Effect<
  { readonly kind: CommandCleanupFailureKind; readonly backend: string | null },
  never
> {
  return pty.findProcess(ptyProcessId).pipe(
    Effect.map((row) => {
      if (!row) return { kind: 'unclassified' as const, backend: null };
      return {
        kind: terminalPtyFactsForRow(row) ? ('terminal_gated' as const) : ('unresolved' as const),
        backend: row.backend,
      };
    }),
    // A read failure is not evidence about the process. Refusing to classify is
    // the conservative answer: the caller still gates on the failure, and
    // nothing is repaired on the strength of a broken read.
    Effect.orElseSucceed(() => ({ kind: 'unclassified' as const, backend: null })),
  );
}

const bootReadoptDetail = (message: string) =>
  `Could not stop or verify this command's recorded process after a runtime restart: ${message}`;

const noProcessDetail = 'The launch never started a process.';

/**
 * Reconcile every command against process reality once, at runtime startup.
 *
 * Runs during service construction, after the PTY layer's own startup
 * reconciliation and before the event subscriber and startup activation exist —
 * so nothing here competes with a live flow, and nothing published here has a
 * client to reach.
 *
 * It never launches anything. A command the runtime interrupted is left
 * `suspended`, and the startup activation pass that follows resumes it through
 * the same path a worktree switch uses.
 */
export const reconcileCommandsAtBoot = Effect.fnUntraced(function* (
  deps: CommandConvergenceDependencies,
) {
  const workset = yield* buildBootWorkset(deps);

  for (const entry of workset) {
    yield* deps.withLock(entry.target, convergeCommandAtBoot(deps, entry)).pipe(
      Effect.catch((error) =>
        Effect.logWarning('Command boot convergence failed').pipe(
          Effect.annotateLogs({
            worktreeId: entry.target.worktreeId,
            commandName: entry.target.commandName,
            cause: describeOperationalCause(error),
          }),
        ),
      ),
    );
  }

  yield* sweepLinklessRunningRuns(deps);
});

interface BootWorksetEntry {
  readonly target: CommandTarget;
  readonly candidates: readonly number[];
  // Whether the command's durable state claims it is running. A command that
  // only appears through a surviving incarnation gets its process cleaned up
  // and its record left alone — that record was just made true.
  readonly claimsRunning: boolean;
}

const buildBootWorkset = Effect.fnUntraced(function* (deps: CommandConvergenceDependencies) {
  const entries = new Map<
    string,
    { target: CommandTarget; candidates: number[]; claimsRunning: boolean }
  >();
  const keyOf = (target: CommandTarget) => `${target.worktreeId}:${target.commandName}`;
  const entryFor = (target: CommandTarget) => {
    const key = keyOf(target);
    const existing = entries.get(key);
    if (existing) return existing;
    const created = { target, candidates: [] as number[], claimsRunning: false };
    entries.set(key, created);
    return created;
  };

  // (a) every command whose durable state still says `running`.
  const runningStates = yield* deps.commandRepository.listRunningStates;
  for (const state of runningStates) {
    entryFor({
      worktreeId: state.worktreeId,
      commandName: state.commandName,
    }).claimsRunning = true;
  }

  // (b) every command-linked incarnation that has not ended, whatever the
  // command's status says — the crash-surviving half. Dispatch stays generic:
  // which backends can actually survive a restart is a property of the row,
  // not something this pass encodes.
  const links = yield* deps.commandRepository.listCommandPtyLinks;
  for (const link of links) {
    if (!(yield* isNonterminalLink(deps.pty, link))) continue;
    entryFor({ worktreeId: link.worktreeId, commandName: link.commandName }).candidates.push(
      link.ptyProcessId,
    );
  }

  return [...entries.values()] as readonly BootWorksetEntry[];
});

function isNonterminalLink(pty: Pick<PtyService['Service'], 'findProcess'>, link: CommandPtyLink) {
  return pty.findProcess(link.ptyProcessId).pipe(
    Effect.map((row) => row !== null && terminalPtyFactsForRow(row) === null),
    // An unreadable row is not a finished process. Including it costs one
    // cleanup attempt that will report its own failure honestly; excluding it
    // would silently drop a possibly-live incarnation from the workset.
    Effect.catch((error) =>
      Effect.logWarning(
        'Command boot could not read a linked incarnation; treating it as unresolved',
      ).pipe(
        Effect.annotateLogs({
          worktreeId: link.worktreeId,
          commandName: link.commandName,
          ptyProcessId: link.ptyProcessId,
          cause: describeOperationalCause(error),
        }),
        Effect.as(true),
      ),
    ),
  );
}

const convergeCommandAtBoot = Effect.fnUntraced(function* (
  deps: CommandConvergenceDependencies,
  entry: BootWorksetEntry,
): Effect.fn.Return<void, DatabaseError> {
  const cleanup = yield* cleanupCommandIncarnations(deps, {
    target: entry.target,
    candidates: entry.candidates,
    reason: 'runtime_shutdown',
    ensureBackendAbsence: false,
    readoptDetail: bootReadoptDetail,
    operation: 'boot',
  });

  // Anything unresolved has already been re-adopted or deliberately left
  // divergent. Either way the command is not finished, so no terminal outcome
  // may be written over it.
  if (cleanup.failures.length > 0) return;
  if (!entry.claimsRunning) return;

  // Re-read under the lock rather than trusting the pre-lock snapshot.
  const state = yield* deps.commandRepository.findState(entry.target);
  if (state?.status !== 'running') return;

  yield* repairResolvedRunningCommand(deps, entry.target, state);
});

const repairResolvedRunningCommand = Effect.fnUntraced(function* (
  deps: CommandConvergenceDependencies,
  target: CommandTarget,
  state: CommandStateRow,
) {
  const run = yield* deps.commandRepository.findLatestRun(target);

  if (run?.status === 'running') {
    // The run was still open when the runtime stopped, but that alone does not
    // say the runtime ended it: a process can exit, or its backend lose it,
    // with the PTY row recording that just before the command subscriber stops.
    // So the incarnation's own terminal facts decide, through the same mapping
    // the event path uses, and only a runtime ending suspends the command for
    // the activation pass to resume. With no terminal facts to read — no linked
    // process, or a row that is gone — the run was cut off with the runtime,
    // which is the interruption.
    const process =
      run.ptyProcessId === null ? null : yield* deps.pty.findProcess(run.ptyProcessId);
    const terminal = terminalPtyFactsForRow(process);
    const outcome = terminal
      ? terminalCommandOutcomeForPtyRow(terminal, 'event')
      : runtimeInterruptedCommandOutcome;
    yield* deps.finalizeCommandRunByRun({
      runId: run.id,
      worktreeId: target.worktreeId,
      commandName: target.commandName,
      runStatus: outcome.runStatus,
      stateStatus: outcome.stateStatus,
      runDiagnostic: outcome.diagnostic,
    });
    return;
  }

  if (run) {
    // The run already knows how this ended; the state is what is stale.
    // Repairing it from the run's own record is what keeps a bare `failed`
    // from being written over a clean `exited`, and a runtime interruption
    // from losing its suspension.
    const status = commandStateForCompletedRun({ ...run, status: run.status });
    yield* deps.commandRepository.transitionState({
      worktreeId: target.worktreeId,
      commandName: target.commandName,
      status,
      activePtyProcessId: null,
    });
    yield* deps.publishCommandChanged(target.worktreeId, target.commandName, status);
    return;
  }

  // No run at all under a `running` state — out of model, since a run is
  // created before any pointer is written. Nothing carries a diagnostic, so
  // the state is simply made honest.
  yield* Effect.logWarning('Command boot found a running state with no run').pipe(
    Effect.annotateLogs({
      worktreeId: target.worktreeId,
      commandName: target.commandName,
      stateId: state.id,
    }),
  );
  yield* deps.commandRepository.transitionState({
    worktreeId: target.worktreeId,
    commandName: target.commandName,
    status: 'failed',
    activePtyProcessId: null,
  });
  yield* deps.publishCommandChanged(target.worktreeId, target.commandName, 'failed');
});

/**
 * Close runs that are still `running`, name no incarnation, and belong to a
 * command that is not running either.
 *
 * All three predicates are required, and together they are structurally
 * disjoint from re-adoption's output: a re-adopted run is always linked to its
 * incarnation and its state is always `running`. That is what lets this run
 * last without any risk of undoing the repair above.
 *
 * The only flow that produces such a run is a launch that suffered a database
 * fault before it could write its own marker. Nothing is published: boot
 * precedes client connections, and no entity state changes here.
 */
const sweepLinklessRunningRuns = Effect.fnUntraced(function* (
  deps: CommandConvergenceDependencies,
) {
  const residue = yield* deps.commandRepository.listLinklessRunningRuns;
  for (const run of residue) {
    const target = { worktreeId: run.worktreeId, commandName: run.commandName };
    yield* deps
      .withLock(
        target,
        Effect.gen(function* () {
          const state = yield* deps.commandRepository.findState(target);
          if (state?.status === 'running') return;
          yield* deps.commandRepository.completeRun({
            runId: run.id,
            status: 'failed',
            diagnosticReason: 'pty_launch_failed',
            diagnosticDetail: noProcessDetail,
          });
        }),
      )
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning('Command boot run-residue sweep failed').pipe(
            Effect.annotateLogs({
              worktreeId: target.worktreeId,
              commandName: target.commandName,
              runId: run.id,
              cause: describeOperationalCause(error),
            }),
          ),
        ),
      );
  }
});
