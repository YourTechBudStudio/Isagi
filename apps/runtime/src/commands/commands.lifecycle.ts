import { Effect } from 'effect';

import type { CommandActionOutput } from '@isagi/contracts';

import type { DatabaseError } from '../persistence/index.js';
import type {
  WorktreeCommandCatalogConfig,
  WorktreeCommandConfig,
} from '../project-config/project-config.schema.js';
import { loadWorktreeCommandCatalog } from '../project-config/project-config.service.js';
import type { DurablePtyTerminationReason } from '../pty-processes/index.js';
import type { WorkspaceRepositoryService } from '../workspace/index.js';
import type {
  CommandCleanupFailure,
  CommandCleanupResult,
  CommandTarget,
} from './commands.convergence.js';
import { describeOperationalCause } from './commands.diagnostics.js';
import { CommandError, type CommandServiceError } from './commands.errors.js';
import type { CommandStopCause, CommandStopResult } from './commands.outcomes.js';
import type { CommandRepositoryService, CommandStateRow } from './commands.repository.js';
import { loadCommandTarget } from './commands.targets.js';

// The worktree-level command passes: what happens to a worktree's commands when
// it is created, activated, deactivated, or deleted.
//
// Each pass is a sweep over a snapshot — one catalog read, one state read —
// followed by per-command operations that each take the command's lock and
// re-read what they are about to act on. The snapshot decides *who* to visit;
// the lock plus the fresh read decides *what happens*, so a launch, a stop, or a
// config edit racing the pass wins on the merits instead of on timing.

type ActivationCause = 'active_context_changed' | 'startup_restored';

export interface ActivationPlanEntry {
  readonly commandName: string;
  // `resume` brings back a command a worktree switch suspended; `automation` is
  // a configured `activate.start` opt-in's first start. The two sets are
  // disjoint by construction — `suspended` versus absent/`idle` — so no
  // precedence rule is needed.
  readonly reason: 'resume' | 'automation';
}

// What one plan entry did, reported to the pass so its summary counts observed
// results rather than inferring them from the plan or from command status.
type ActivationEntryOutcome = 'executed' | 'discarded';

export interface CommandLifecycleDependencies {
  readonly workspaceRepository: WorkspaceRepositoryService;
  readonly commandRepository: CommandRepositoryService;
  readonly runCommand: (input: {
    readonly worktreeId: number;
    readonly commandName: string;
  }) => Effect.Effect<CommandActionOutput, CommandServiceError>;
  // Stops a command the config still names, failing `command_not_found` for a
  // name nothing knows. preDelete keeps this shape so a worktree delete reports
  // the same rejection reasons it always has.
  readonly stopCommand: (
    input: { readonly worktreeId: number; readonly commandName: string },
    options: { readonly cause: CommandStopCause },
  ) => Effect.Effect<CommandActionOutput, CommandServiceError>;
  // Stops a command by its durable state alone. The passes need this because a
  // command can outlive its config entry — removed by an edit, or unreadable
  // because the file no longer parses — and the runtime still owns its process.
  readonly stopManagedCommand: (
    input: { readonly worktreeId: number; readonly commandName: string },
    options: { readonly cause: CommandStopCause },
  ) => Effect.Effect<CommandStopResult, CommandServiceError>;
  // Process accounting for one command, shared with boot convergence: clean up
  // every incarnation it still refers to and repair ownership when exactly one
  // nonterminal survivor remains. The audit below supplies its own reason and
  // diagnostic wording, because "a worktree delete could not finish" is a
  // different thing to tell the user than "the runtime restarted".
  readonly cleanupIncarnations: (input: {
    readonly target: CommandTarget;
    readonly candidates: readonly number[];
    readonly reason: DurablePtyTerminationReason;
    readonly ensureBackendAbsence: boolean;
    readonly readoptDetail: (message: string) => string;
    readonly operation: string;
  }) => Effect.Effect<CommandCleanupResult, DatabaseError>;
  readonly withLock: <A, E, R>(
    input: { readonly worktreeId: number; readonly commandName: string },
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

export function makeCommandLifecycle(deps: CommandLifecycleDependencies) {
  const { workspaceRepository, commandRepository, runCommand, stopCommand, stopManagedCommand } =
    deps;

  const worktreeCatalog = (worktreeId: number) =>
    Effect.gen(function* () {
      const target = yield* loadCommandTarget(workspaceRepository, worktreeId);
      const catalog = yield* loadWorktreeCommandCatalog({
        worktreeRootPath: target.worktree.path,
      });
      return { worktreeRootPath: target.worktree.path, catalog };
    });

  const runPostCreateLifecycle = (worktreeId: number) =>
    Effect.gen(function* () {
      const { catalog } = yield* worktreeCatalog(worktreeId);
      if (catalog.status === 'config_error') {
        console.warn(
          `[runtime] Command postCreate lifecycle skipped for worktree ${worktreeId}: ${catalog.diagnostic.message}`,
        );
        return;
      }
      // No state rows exist yet just after a worktree is created, so there is no
      // prior outcome to gate on here — unlike activation, where there is.
      for (const command of catalog.config.commands) {
        if (!command.lifecycle.postCreate.start) continue;
        yield* deps
          .withLock(
            { worktreeId, commandName: command.name },
            runCommand({ worktreeId, commandName: command.name }),
          )
          .pipe(Effect.catchAll(logLifecycleError(`postCreate:${command.name}`)));
      }
    }).pipe(Effect.catchAll(logLifecycleError('postCreate')));

  const stopPreDeleteCommands = (worktreeId: number) =>
    Effect.gen(function* () {
      const { catalog } = yield* worktreeCatalog(worktreeId);
      if (catalog.status === 'config_error') {
        console.warn(
          `[runtime] Command preDelete lifecycle skipped for worktree ${worktreeId}: ${catalog.diagnostic.message}`,
        );
        return;
      }
      // Propagating, unlike deactivation: a worktree delete that could not stop
      // a command must report `command_cleanup_failed` rather than silently
      // orphan a live process.
      for (const command of catalog.config.commands) {
        if (!command.lifecycle.preDelete.stop) continue;
        yield* deps.withLock(
          { worktreeId, commandName: command.name },
          stopCommand({ worktreeId, commandName: command.name }, { cause: 'user' }),
        );
      }
    });

  const stopAllManagedCommands = (worktreeId: number) =>
    Effect.gen(function* () {
      const states = yield* commandRepository.listRunningStatesForWorktree(worktreeId);
      for (const state of states) {
        yield* deps.withLock(
          { worktreeId: state.worktreeId, commandName: state.commandName },
          stopManagedCommand(
            { worktreeId: state.worktreeId, commandName: state.commandName },
            { cause: 'user' },
          ),
        );
      }
    });

  // The last gate before a worktree's rows are cascaded away.
  //
  // Stopping the commands the runtime knows are running is not enough to
  // conclude that no process survives: a link can outlive its command's status,
  // and a backend session can outlive its row. So every incarnation this
  // worktree's commands still refer to — from state pointers *and* retained run
  // links — is audited, and the delete proceeds only if every one of them is
  // either terminated here or verified absent.
  //
  // `ensureBackendAbsence` is set for every link, not only the ones that look
  // terminal. Classifying first would leave a hole: a row that goes terminal
  // between the read and the cleanup would skip its gating kill, and a session
  // that materialized behind it would survive the cascade unobserved.
  //
  // No *cleanup failure* short-circuits: one command's unkillable process must
  // not hide whether the next command's is still alive, because the user is
  // going to retry this delete and the retry needs every survivor findable. A
  // database fault while repairing ownership does stop the pass — at that point
  // the runtime cannot record what it is learning, so continuing would only
  // produce conclusions it has nowhere to put.
  const auditWorktreeCommandIncarnations = (worktreeId: number) =>
    Effect.gen(function* () {
      const links = yield* commandRepository.listCommandPtyLinksForWorktree(worktreeId);
      const byCommand = new Map<string, number[]>();
      for (const link of links) {
        const candidates = byCommand.get(link.commandName);
        if (candidates) candidates.push(link.ptyProcessId);
        else byCommand.set(link.commandName, [link.ptyProcessId]);
      }

      const failures: CommandCleanupFailure[] = [];
      for (const [commandName, candidates] of byCommand) {
        const result = yield* deps.withLock(
          { worktreeId, commandName },
          deps.cleanupIncarnations({
            target: { worktreeId, commandName },
            candidates,
            reason: 'user_requested',
            ensureBackendAbsence: true,
            readoptDetail: deletionReadoptDetail,
            operation: 'worktree_cleanup',
          }),
        );
        failures.push(...result.failures);
      }

      if (failures.length === 0) return;
      // Propagate. The workspace wrapper turns this into `command_cleanup_failed`
      // and the worktree's rows — including every link to an unresolved
      // incarnation — survive, so the retry's fresh read finds them all again.
      return yield* Effect.fail(
        new CommandError({
          code: 'command_action_failed',
          message: `Could not account for ${failures.length} command process(es) while cleaning up worktree ${worktreeId}.`,
          worktreeId,
          cause: failures[0]?.error,
        }),
      );
    });

  // Leaving a worktree. Two candidate sets, both drawn from one authoritative
  // catalog:
  //
  //   configured — every catalog entry whose `deactivate.stop` is true, whatever
  //     its snapshot state says. Enumerating from the catalog rather than from
  //     the running states is what makes a stop queue behind a launch that is
  //     still in flight, instead of racing it.
  //   swept — every command with a state row whose name the catalog no longer
  //     contains. A command removed from config still has a process, and the
  //     user still left the worktree.
  //
  // A configured `deactivate.stop: false` opt-out is structurally excluded from
  // both: it fails the first set's predicate and, being a configured name, can
  // never appear in the second.
  //
  // An unreadable config skips the entire pass. Under a broken config the two
  // rules conflict and one has to lose: suspending everything would terminate
  // exactly the documented keep-alive commands (a database, a compose stack) on
  // the strength of a YAML typo. Killing a live database is irreversible;
  // leaving commands running is recoverable, and the failure is already loud in
  // the drawer, the status strip, and this log line.
  const deactivateWorktreeCommands = (worktreeId: number) =>
    Effect.gen(function* () {
      const { catalog } = yield* worktreeCatalog(worktreeId);
      if (catalog.status === 'config_error') {
        console.warn(
          `[runtime] Command deactivate lifecycle skipped for worktree ${worktreeId}: ${catalog.diagnostic.message}. Running commands were left alone so a configured keep-alive command is not stopped on the strength of an unreadable config.`,
        );
        return;
      }
      const states = yield* commandRepository.listStatesForWorktree(worktreeId);
      const candidates = deactivationCandidates(catalog.config, states);

      let suspended = 0;
      let failures = 0;
      for (const candidate of candidates) {
        const outcome = yield* deps
          .withLock(
            { worktreeId, commandName: candidate.commandName },
            stopManagedCommand(
              { worktreeId, commandName: candidate.commandName },
              { cause: 'deactivation' },
            ),
          )
          .pipe(Effect.either);
        if (outcome._tag === 'Left') {
          failures += 1;
          yield* logLifecycleError(`deactivate:${candidate.commandName}`)(outcome.left);
          continue;
        }
        // Only a stop that actually minted the intent is counted: an
        // already-suspended command, an absent process, and a command that was
        // never running are all no-ops, and reporting them as suspensions would
        // make this line useless for diagnosing AC1.
        if (outcome.right.resolution === 'suspended') suspended += 1;
      }
      // `considered`, not `swept`: the unconfigured set is every state row the
      // catalog no longer names, most of which are already finished and stop
      // nothing. Reporting enumeration as if it were effect is the same lie the
      // `suspended` count above is careful to avoid.
      console.info(
        `[runtime] Deactivation suspended ${suspended} command(s), considered ${candidates.filter((candidate) => candidate.origin === 'swept').length} unconfigured, failed ${failures}, worktree=${worktreeId}`,
      );
    });

  // Arriving at a worktree. One plan is built from one snapshot, then each entry
  // re-verifies itself against fresh state *and* fresh config inside the
  // command's lock: config is re-read per operation, and the pass is serial, so
  // by the time an entry executes the user may have stopped the command or
  // edited it away. Newer intent always wins over the plan.
  const activateWorktreeCommands = (worktreeId: number, cause: ActivationCause) =>
    Effect.gen(function* () {
      const { worktreeRootPath, catalog } = yield* worktreeCatalog(worktreeId);
      if (catalog.status === 'config_error') {
        console.warn(
          `[runtime] Command activate lifecycle skipped for worktree ${worktreeId}: ${catalog.diagnostic.message}`,
        );
        return;
      }
      const states = yield* commandRepository.listStatesForWorktree(worktreeId);
      const plan = buildActivationPlan({ commands: catalog.config.commands, states, cause });

      let resumed = 0;
      let automated = 0;
      let discarded = 0;
      let errored = 0;
      for (const entry of plan) {
        const outcome = yield* deps
          .withLock(
            { worktreeId, commandName: entry.commandName },
            executeActivationEntry(worktreeId, worktreeRootPath, entry),
          )
          .pipe(Effect.either);
        if (outcome._tag === 'Left') {
          errored += 1;
          yield* logLifecycleError(`activate:${entry.commandName}`)(outcome.left);
          continue;
        }
        if (outcome.right === 'discarded') {
          discarded += 1;
          continue;
        }
        if (entry.reason === 'resume') resumed += 1;
        else automated += 1;
      }
      // Counted from what the executor actually did, never inferred. `executed`
      // means the entry passed both rechecks and `runCommand` returned — a
      // launch can still return a `failed` action, and a spawned command can
      // exit immediately, so the durable command and run status remain the
      // authority for whether it is running, exited, or failed.
      console.info(
        `[runtime] Activation completed: executed ${resumed} resume(s) and ${automated} automation start(s), discarded ${discarded}, errored ${errored}, worktree=${worktreeId} cause=${cause}`,
      );
    });

  const executeActivationEntry = (
    worktreeId: number,
    worktreeRootPath: string,
    entry: ActivationPlanEntry,
  ): Effect.Effect<ActivationEntryOutcome, CommandServiceError> =>
    Effect.gen(function* () {
      const discard = (reason: string) =>
        Effect.sync(() => {
          console.info(
            `[runtime] Activation discarded command=${entry.commandName} reason=${entry.reason} because=${reason}`,
          );
          return 'discarded' as const;
        });

      const state = yield* commandRepository.findState({
        worktreeId,
        commandName: entry.commandName,
      });
      // Config is hot and re-read per operation, so the plan's snapshot is not
      // authoritative by the time a serial backlog reaches this entry. That
      // costs one parse here and one more inside `runCommand`, which resolves
      // the command itself; at desktop scale that is the right trade for
      // letting a config edit beat a stale plan.
      const fresh = yield* loadWorktreeCommandCatalog({ worktreeRootPath });
      if (fresh.status === 'config_error') return yield* discard('config_error');
      const command = fresh.config.commands.find(
        (candidate) => candidate.name === entry.commandName,
      );
      if (!command) return yield* discard('config_removed');

      if (entry.reason === 'resume') {
        // An explicit Stop between the snapshot and now cleared the intent, and
        // it is the newer decision.
        if (state?.status !== 'suspended') return yield* discard('state_changed');
      } else {
        if (state && state.status !== 'idle') return yield* discard('state_changed');
        // `activate.start` flipped off after planning must not launch.
        if (!command.lifecycle.activate.start) return yield* discard('config_changed');
      }

      console.info(
        `[runtime] Activation launch command=${entry.commandName} reason=${entry.reason}`,
      );
      // A failed launch lands in ordinary `failed` diagnostics. The intent is
      // consumed by the *failed state transition* the launch writes — not by the
      // marker, which a pre-marker failure such as `missing_cwd`, `env_invalid`,
      // or `port_allocation_failed` never reaches. Either way the command leaves
      // `suspended`, so a failed resume does not re-arm itself for the next
      // activation: `suspended` means "waiting to resume", and a command whose
      // launch failed is not waiting, it is failed and says so.
      yield* runCommand({ worktreeId, commandName: entry.commandName });
      return 'executed' as const;
    });

  const applyActivationLifecycle = (input: {
    readonly previousWorktreeId: number | null;
    readonly nextWorktreeId: number | null;
    readonly cause: ActivationCause;
  }) =>
    Effect.gen(function* () {
      // Ordered, and deliberately serial: the previous worktree's commands are
      // suspended before the next worktree's are started.
      if (input.previousWorktreeId !== null) {
        yield* deactivateWorktreeCommands(input.previousWorktreeId).pipe(
          Effect.catchAll(logLifecycleError('deactivate')),
        );
      }
      if (input.nextWorktreeId !== null) {
        yield* activateWorktreeCommands(input.nextWorktreeId, input.cause).pipe(
          Effect.catchAll(logLifecycleError('activate')),
        );
      }
    });

  return {
    runPostCreateLifecycle,
    stopPreDeleteCommands,
    stopAllManagedCommands,
    auditWorktreeCommandIncarnations,
    applyActivationLifecycle,
  } as const;
}

interface DeactivationCandidate {
  readonly commandName: string;
  readonly origin: 'configured' | 'swept';
}

function deactivationCandidates(
  config: WorktreeCommandCatalogConfig,
  states: readonly CommandStateRow[],
): readonly DeactivationCandidate[] {
  const configuredNames = new Set(config.commands.map((command) => command.name));
  const configured = config.commands
    .filter((command) => command.lifecycle.deactivate.stop)
    .map((command) => ({ commandName: command.name, origin: 'configured' as const }));
  const swept = states
    .filter((state) => !configuredNames.has(state.commandName))
    .map((state) => ({ commandName: state.commandName, origin: 'swept' as const }));
  return [...configured, ...swept];
}

// The activation decision, as a pure function of one snapshot. It reads and
// writes nothing: everything operational — the fresh re-reads, the locks, the
// launches — happens in the executor above.
export function buildActivationPlan(input: {
  readonly commands: readonly WorktreeCommandConfig[];
  readonly states: readonly CommandStateRow[];
  readonly cause: ActivationCause;
}): readonly ActivationPlanEntry[] {
  const stateByName = new Map(input.states.map((state) => [state.commandName, state]));
  const entries: ActivationPlanEntry[] = [];
  for (const command of input.commands) {
    const state = stateByName.get(command.name);
    // A resume is a user-driven return. Restoring the runtime is not one: after
    // a restart the user is looking at a worktree they did not just choose, and
    // nothing should start without them.
    if (state?.status === 'suspended') {
      if (input.cause === 'active_context_changed') {
        entries.push({ commandName: command.name, reason: 'resume' });
      }
      continue;
    }
    // First start only. Any prior outcome — `exited`, `failed`, `stopped`,
    // `suspended` — excludes the command, so automation cannot revive something
    // that already ended on its own or was deliberately stopped.
    if (command.lifecycle.activate.start && (!state || state.status === 'idle')) {
      entries.push({ commandName: command.name, reason: 'automation' });
    }
  }
  return entries;
}

const deletionReadoptDetail = (message: string) =>
  `Could not stop the process during worktree cleanup: ${message}`;

function logLifecycleError(operation: string) {
  return (error: unknown) =>
    Effect.sync(() => {
      console.warn(
        `[runtime] Command lifecycle ${operation} failed cause=${describeOperationalCause(error)}`,
      );
    });
}
