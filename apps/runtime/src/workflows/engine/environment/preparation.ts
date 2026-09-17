import { Effect, Schema } from 'effect';

import {
  workflowEnvironmentFailureDetailSchema,
  type WorkflowEnvironmentFailureReason,
  type WorkflowEnvironmentStep,
  type WorkflowSetupReceipt,
  type WorkflowSurfaceReceipt,
  type WorkflowWorktreeReceipt,
  type OpenWorktreeOutput,
  type WorktreeSetupResult,
} from '@isagi/contracts';

import { GitCommandError } from '../../../git/index.js';
import type { DatabaseError } from '../../../persistence/index.js';
import { SurfaceError } from '../../../surfaces/index.js';
import { WorkspaceError } from '../../../workspace/workspace.service.js';
import { WorktreeSetupError } from '../../../worktree-setup/index.js';
import { setupIsIncomplete } from '../../persistence/preparations.js';
import type { WorkflowRunPreparationRecord } from '../../persistence/records.js';
import {
  advanced,
  halted,
  recordSegmentFailure,
  segmentFailure,
  type SegmentFailure,
  type SegmentFault,
  type SegmentOutcome,
} from '../segments/shared.js';
import { fenceOf } from '../segments/shared.js';
import type { PreparationContext, PreparationDeps } from './types.js';

/**
 * The environment a run was placed in, brought into existence.
 *
 * Four steps — worktree, setup, surface, commit — run as one ordinary segment against the attempt
 * `createRun` (or Retry) claimed. It is not a parallel lifecycle: attempts, the ownership fence,
 * failure records, retained history and Retry all come from the same machinery every other segment
 * uses, which is the whole reason preparation is modelled this way (architecture §4.6).
 *
 * Two invariants carry the design, and both are visible in the shape below.
 *
 * **Every step reads its receipt first.** A receipt exists only where this launch *allocated*
 * something, so reading it is what makes a re-entry reuse rather than create a second worktree or a
 * second surface. Reuse choices (`current`, `existing`) allocate nothing, leave no receipt and are
 * re-validated against live rows on every attempt — which is why `preparation.worktree` and
 * `preparation.surface` mean exactly "what this launch brought into existence" and nothing else.
 *
 * **Nothing is ever deleted on any path.** Not a worktree, a branch, a checkout or a surface, on any
 * failure route, including a failure that happens one step after the allocation. Setup hooks may
 * already have put valuable files in a checkout, and a run that half-prepared is expected to say
 * what exists rather than to tidy up behind itself.
 */
export function prepareEnvironment(
  deps: PreparationDeps,
  ctx: PreparationContext,
): Effect.Effect<SegmentOutcome, SegmentFault> {
  return Effect.gen(function* () {
    const fence = fenceOf(deps, ctx);

    /**
     * The durable decision, re-read rather than carried in memory from the launch.
     *
     * A Retry arrives here in a new process with nothing but the run id, so reading the row is the
     * only thing that works on both paths — and having one path means the first attempt exercises
     * exactly what a retry will.
     */
    let prep = yield* requirePreparation(deps, ctx);
    const request = prep.request;

    // --- step 1: worktree -----------------------------------------------------------------------
    let worktree: ResolvedWorktree;
    if (prep.worktree !== null) {
      worktree = yield* requireWorktree(deps, prep.worktree.worktreeId);
    } else if (request.worktree.kind !== 'create') {
      const worktreeId =
        request.worktree.kind === 'current'
          ? ctx.run.origin.worktreeId
          : request.worktree.worktreeId;
      if (worktreeId === null) {
        // The origin columns are nullable because retained history outlives the rows it names (ADR
        // 0006). A `current` choice that can no longer say what "current" was is unpreparable.
        return yield* fail({
          step: 'worktree',
          reason: 'worktree_missing',
          message: `Run ${ctx.run.id} no longer records the worktree it was launched from.`,
        });
      }
      worktree = yield* requireWorktree(deps, worktreeId);
      if (request.worktree.kind === 'existing') {
        // Re-checked on every attempt, not trusted from launch: a worktree can be deleted and its
        // id reused between the launch's validation and this step.
        const projectId = yield* requireLaunchProjectId(deps, ctx);
        if (worktree.projectId !== projectId) {
          return yield* fail({
            step: 'worktree',
            reason: 'worktree_missing',
            message: `Worktree ${worktree.id} is not in project ${projectId}.`,
            worktreeId: worktree.id,
          });
        }
      }
    } else {
      const created = yield* createWorktree(deps, ctx, prep, request.worktree);
      worktree = created.worktree;
      // Re-read after the receipts this step wrote, so step 2 never tests a stale snapshot. The
      // worktree and setup receipts are two transactions, and what step 2 must see is both.
      prep = yield* requirePreparation(deps, ctx);
      if (created.setupFailed) {
        return yield* fail({
          step: 'setup',
          reason: 'setup_failed',
          message: created.setupFailed.message,
          worktreeId: worktree.id,
          ...(created.setupFailed.diagnostic === undefined
            ? {}
            : { diagnostic: created.setupFailed.diagnostic }),
        });
      }
    }

    // --- step 2: setup --------------------------------------------------------------------------
    /**
     * Hooks run again whenever a created or adopted worktree's setup is not known good.
     *
     * "Not known good" is `setupIsIncomplete`'s sentence, not a second copy of it: the progress
     * projection reads the same predicate to report which step a preparation is sitting at, and two
     * definitions that drifted would make the inspector and this segment disagree about whether
     * somebody's hooks still need to run.
     *
     * The `create` guard stays here, because it is about this *request* rather than about the
     * receipt: a reused worktree is not this launch's to set up, and leaves `setup` null forever.
     */
    if (request.worktree.kind === 'create' && setupIsIncomplete(prep.setup)) {
      const result = yield* deps.workspaceService
        .runWorktreeSetup({ projectId: worktree.projectId, worktreeId: worktree.id })
        .pipe(
          Effect.catchAll(
            (error): Effect.Effect<never, PreparationError> =>
              owningFailure('setup', error, { worktreeId: worktree.id }),
          ),
        );
      yield* recordReceipt(deps, fence, { step: 'setup', receipt: setupReceiptOf(result) });
      if (result.status === 'failed') {
        return yield* fail({
          step: 'setup',
          reason: 'setup_failed',
          message: result.message,
          worktreeId: worktree.id,
          ...(result.outputExcerpt === undefined ? {} : { diagnostic: result.outputExcerpt }),
        });
      }
    }

    // --- step 3: surface ------------------------------------------------------------------------
    let surfaceId: number;
    if (prep.surface !== null) {
      surfaceId = (yield* requireSurface(deps, prep.surface.surfaceId, worktree)).id;
    } else if (request.surface.kind !== 'create') {
      const requested =
        request.surface.kind === 'current' ? ctx.run.origin.surfaceId : request.surface.surfaceId;
      if (requested === null) {
        return yield* fail({
          step: 'surface',
          reason: 'surface_missing',
          message: `Run ${ctx.run.id} no longer records the surface it was launched from.`,
        });
      }
      surfaceId = (yield* requireSurface(deps, requested, worktree)).id;
    } else {
      const requestedTitle = request.surface.title;
      const created = yield* deps.surfaces
        .createSinglePaneSurface({
          worktreeId: worktree.id,
          titleBase: requestedTitle,
          // The key, not the title, is what stops a re-entry creating a second surface: a duplicate
          // title is rewritten by `duplicateSafeTitle` and is not a failure, so titles cannot
          // identify anything. Written to `worktree_surfaces.creation_key`, its own keyspace.
          creationKey: surfaceCreationKey(ctx.run.id),
        })
        .pipe(
          Effect.catchAll(
            (error): Effect.Effect<never, PreparationError> =>
              isDatabaseFault(error)
                ? Effect.fail(error)
                : fail({ step: 'surface', ...surfaceRejection(error, worktree.id) }),
          ),
        );
      yield* recordReceipt(deps, fence, {
        step: 'surface',
        receipt: { surfaceId: created.surfaceId, requestedTitle, title: created.title },
      });
      surfaceId = created.surfaceId;
    }

    // --- step 4: commit -------------------------------------------------------------------------
    const committed = yield* deps.runs.commitEnvironmentPreparation({
      ...fence,
      destination: { worktreeId: worktree.id, worktreePath: worktree.path, surfaceId },
    });
    if (!committed.ok) {
      // `surface_busy` is the one rejection here that is an operational condition rather than a
      // sign this worker lost the attempt: the pre-check at launch read a free surface and
      // something took it in between. It is a retained, inspectable, retryable failure.
      if (committed.rejection.kind === 'surface_busy') {
        return yield* fail({
          step: 'commit',
          reason: 'surface_busy',
          message: `Surface ${surfaceId} already has a workflow attached.`,
          surfaceId,
          occupyingRunId: committed.rejection.runId,
        });
      }
      return halted(`rejected:${committed.rejection.kind}`);
    }
    // Cancel revokes permission to advance, never permission to record: the receipts above stand,
    // and the run rests terminal at `environment_preparation` with no destination and no attachment.
    if (committed.value === 'cancelled_evidence') return halted('cancelled_evidence');

    yield* deps.poke;
    return advanced;
  }).pipe(
    Effect.catchTag('WorkflowPreparationHalt', (stop) => Effect.succeed(halted(stop.reason))),
    // The same handler `runGraphEntry` ends with, reached through the same narrowed helpers: a
    // preparation failure is an ordinary retained failed attempt, not a fault.
    Effect.catchTag('WorkflowSegmentFailure', recordSegmentFailure(deps, ctx)),
  );
}

/** The creation key a run's surface is created under. One per run, stable across every attempt. */
export function surfaceCreationKey(runId: number): string {
  return `workflow-run:${runId}:surface`;
}

/** Everything preparation's own steps can fail with, before the handler sorts them. */
type PreparationError = SegmentFailure | SegmentFault;

/** Whether `openWorktree` produced a worktree, or a collision the adoption predicate must judge. */
type OpenOutcome =
  | { readonly kind: 'opened'; readonly output: OpenWorktreeOutput }
  | { readonly kind: 'collision'; readonly error: WorkspaceError };

interface ResolvedWorktree {
  readonly id: number;
  readonly path: string;
  readonly projectId: number;
}

/**
 * A halt: this fiber is no longer the one advancing the run, so it stops without recording anything.
 *
 * Tagged and separate from `SegmentFailure` because the two mean opposite things. A failure is this
 * attempt's own outcome and is written down; a halt means a Cancel landed or the fence refused, and
 * writing anything further would be this worker talking about a run it no longer holds.
 */
interface PreparationHalt {
  readonly _tag: 'WorkflowPreparationHalt';
  readonly reason: string;
}

function halt(reason: string): Effect.Effect<never, PreparationHalt> {
  return Effect.fail({ _tag: 'WorkflowPreparationHalt', reason } as const);
}

interface FailureInput {
  readonly step: WorkflowEnvironmentStep;
  readonly reason: WorkflowEnvironmentFailureReason;
  readonly message: string;
  readonly worktreeId?: number | undefined;
  readonly surfaceId?: number | undefined;
  readonly branch?: string | undefined;
  readonly occupyingRunId?: number | undefined;
  readonly diagnostic?: string | undefined;
}

const decodeFailureDetail = Schema.decodeUnknownEither(workflowEnvironmentFailureDetailSchema);

/**
 * Raises a preparation failure, with its detail decoded through the contract schema.
 *
 * Decoded rather than merely constructed: the detail is written into the attempt's `failure_detail`
 * slot and read back by the API, the inspector and the web, so a shape those cannot decode would
 * turn a legible failure into an unreadable one at exactly the moment somebody needs to read it.
 */
function fail(input: FailureInput): Effect.Effect<never, SegmentFailure> {
  const { step, reason, message, ...identities } = input;
  const decoded = decodeFailureDetail({
    step,
    reason,
    ...Object.fromEntries(Object.entries(identities).filter(([, value]) => value !== undefined)),
  });
  /**
   * A detail that will not decode degrades to its step and reason; it never throws.
   *
   * The synchronous decoder would have raised here, and a throw inside `Effect.gen` is a defect —
   * which would abandon the claimed attempt until the next startup recovery collected it, for the
   * sake of a malformed *identity field*. That is the same trade the `opened_existing` branch makes
   * below and for the same reason: nothing in this fiber may die while it holds an attempt nobody
   * else will collect. `step` and `reason` are the two fields the web writes its line from, so what
   * survives is the part a person actually reads.
   */
  const detail = (decoded._tag === 'Right' ? decoded.right : { step, reason }) as unknown as Record<
    string,
    unknown
  >;
  return Effect.fail(segmentFailure({ code: 'environment_preparation_failed', message, detail }));
}

function requirePreparation(
  deps: Pick<PreparationDeps, 'runs'>,
  ctx: PreparationContext,
): Effect.Effect<WorkflowRunPreparationRecord, SegmentFailure | SegmentFault> {
  return deps.runs.findPreparation(ctx.run.id).pipe(
    Effect.flatMap((prep) =>
      prep
        ? Effect.succeed(prep)
        : // Defensive: `createRun` writes the preparation row in the same transaction as the run, so
          // this is unreachable on a correct path. Reported as `interrupted` rather than as a defect
          // because a run whose decision cannot be read is precisely a preparation nobody can finish.
          fail({
            step: 'worktree',
            reason: 'interrupted',
            message: `Run ${ctx.run.id} has no preparation record.`,
          }),
    ),
  );
}

/** The project this launch belongs to, re-derived from its origin exactly as the launch did. */
function requireLaunchProjectId(
  deps: Pick<PreparationDeps, 'workspace'>,
  ctx: PreparationContext,
): Effect.Effect<number, SegmentFailure | SegmentFault> {
  const worktreeId = ctx.run.origin.worktreeId;
  if (worktreeId === null) {
    return fail({
      step: 'worktree',
      reason: 'worktree_missing',
      message: `Run ${ctx.run.id} no longer records the worktree it was launched from, so its project cannot be named.`,
    });
  }
  return requireWorktree(deps, worktreeId).pipe(Effect.map((row) => row.projectId));
}

function requireWorktree(
  deps: Pick<PreparationDeps, 'workspace'>,
  worktreeId: number,
): Effect.Effect<ResolvedWorktree, SegmentFailure | SegmentFault> {
  return deps.workspace.findWorktree(worktreeId).pipe(
    Effect.flatMap((row) =>
      row
        ? Effect.succeed({ id: row.id, path: row.path, projectId: row.projectId })
        : fail({
            step: 'worktree',
            reason: 'worktree_missing',
            message: `Worktree ${worktreeId} is no longer there.`,
            worktreeId,
          }),
    ),
  );
}

function requireSurface(
  deps: Pick<PreparationDeps, 'surfaceRepository'>,
  surfaceId: number,
  worktree: ResolvedWorktree,
): Effect.Effect<{ readonly id: number }, SegmentFailure | SegmentFault> {
  return deps.surfaceRepository.findSurface(surfaceId).pipe(
    Effect.flatMap((row) => {
      if (!row) {
        return fail({
          step: 'surface',
          reason: 'surface_missing',
          message: `Surface ${surfaceId} is no longer there.`,
          surfaceId,
        });
      }
      if (row.worktreeId !== worktree.id) {
        return fail({
          step: 'surface',
          reason: 'surface_not_on_worktree',
          message: `Surface ${row.id} is on worktree ${row.worktreeId}, not worktree ${worktree.id}.`,
          surfaceId: row.id,
          worktreeId: worktree.id,
        });
      }
      return Effect.succeed({ id: row.id });
    }),
  );
}

interface CreatedWorktree {
  readonly worktree: ResolvedWorktree;
  /** Set when hooks failed during creation. The worktree is kept; the attempt fails at `setup`. */
  readonly setupFailed:
    | { readonly message: string; readonly diagnostic?: string | undefined }
    | undefined;
}

/**
 * Creating the worktree this launch asked for, or adopting the one its own interrupted attempt left.
 *
 * `mode: 'create_new'` is deliberate: a caller that has decided it is creating something wants a
 * collision reported rather than absorbed into a silent reuse of somebody else's checkout. And the
 * base is the **commit** the launch resolved, not the ref it was named by, so a branch that has
 * moved since does not silently relocate where the run's work starts from (criterion 7).
 */
function createWorktree(
  deps: Pick<
    PreparationDeps,
    'runs' | 'workspace' | 'workspaceService' | 'owner' | 'ownerIncarnation'
  >,
  ctx: PreparationContext,
  prep: WorkflowRunPreparationRecord,
  choice: { readonly kind: 'create'; readonly branch: string; readonly fromRef: string },
): Effect.Effect<CreatedWorktree, SegmentFailure | PreparationHalt | SegmentFault> {
  return Effect.gen(function* () {
    const fence = fenceOf(deps, ctx);
    const branch = choice.branch.trim();
    const projectId = yield* requireLaunchProjectId(deps, ctx);
    const baseCommit = prep.baseCommit;
    if (baseCommit === null) {
      return yield* fail({
        step: 'worktree',
        reason: 'workspace_rejected',
        message: `Run ${ctx.run.id} asked for a new worktree but recorded no base commit to create it from.`,
        branch,
      });
    }

    const opened = yield* deps.workspaceService
      .openWorktree({
        projectId,
        request: { branch, base: { kind: 'commit', commit: baseCommit }, mode: 'create_new' },
      })
      .pipe(
        Effect.map((output): OpenOutcome => ({ kind: 'opened', output })),
        Effect.catchAll((error): Effect.Effect<OpenOutcome, PreparationError> => {
          if (isDatabaseFault(error)) return Effect.fail(error);
          /**
           * Adoption after an interruption, and only on a Retry.
           *
           * A `create` request without a receipt can only be re-entered by Retry, so on an
           * `initial` attempt a collision is always somebody else's worktree. The predicate uses
           * only evidence that does not move: this project, this branch, Isagi's own derived
           * checkout path, and a row first seen no earlier than the preparation itself. HEAD is
           * deliberately excluded — setup hooks and post-create commands run inside the new
           * checkout before any receipt could be written, and may have committed.
           */
          if (
            error._tag === 'WorkspaceError' &&
            error.code === 'worktree_exists' &&
            ctx.attempt.invocationKind === 'retry'
          ) {
            return Effect.succeed({ kind: 'collision', error });
          }
          return owningFailure('worktree', error, { branch });
        }),
      );

    if (opened.kind === 'collision') {
      const candidate = yield* deps.workspace.findProjectWorktreeByBranch({ projectId, branch });
      const adoptable =
        candidate !== null &&
        candidate.path === prep.checkoutPath &&
        candidate.firstSeenAt >= prep.createdAt;
      if (!adoptable) {
        return yield* fail({
          step: 'worktree',
          reason: 'worktree_exists',
          message: `Branch ${branch} is already checked out in project ${projectId} by a worktree this run did not create.`,
          branch,
          ...(candidate === null ? {} : { worktreeId: candidate.id }),
        });
      }
      yield* recordReceipt(deps, fence, {
        step: 'worktree',
        receipt: {
          // Never `created`: the run's own earlier attempt created it and nobody observed the
          // outcome, and the record says so rather than claiming this attempt did the work.
          acquisition: 'adopted_after_interruption',
          worktreeId: candidate.id,
          worktreePath: candidate.path,
          branch,
        },
      });
      yield* recordReceipt(deps, fence, {
        step: 'setup',
        // Nobody observed whether hooks ran, so step 2 re-runs them. `unknown` is the honest word
        // for that, and it is what makes the re-run a decision rather than a guess.
        receipt: { status: 'unknown', reason: 'interrupted', setupRunId: null, failure: null },
      });
      return {
        worktree: { id: candidate.id, path: candidate.path, projectId: candidate.projectId },
        setupFailed: undefined,
      };
    }

    const output = opened.output;
    if (output.status === 'opened_existing') {
      // Unreachable: `create_new` refuses an existing worktree with `worktree_exists` before it can
      // return this. Reported by name rather than died on, because dying inside this fiber would
      // abandon a claimed attempt that no other party will ever collect.
      return yield* fail({
        step: 'worktree',
        reason: 'workspace_rejected',
        message: `Creating worktree for branch ${branch} returned an existing worktree, which 'create_new' should have refused.`,
        branch,
        worktreeId: output.worktreeId,
      });
    }

    const row = yield* requireWorktree(deps, output.worktreeId);
    // The receipt carries the path because retained history outlives the rows it names (ADR 0006):
    // a failure two steps later must still be able to say where the checkout is.
    yield* recordReceipt(deps, fence, {
      step: 'worktree',
      receipt: {
        acquisition: 'created',
        worktreeId: row.id,
        worktreePath: row.path,
        branch: output.branch,
      },
    });
    yield* recordReceipt(deps, fence, { step: 'setup', receipt: setupReceiptOf(output.setup) });

    return {
      worktree: row,
      setupFailed:
        output.status === 'created_setup_failed'
          ? {
              message: output.setup.message,
              ...(output.setup.outputExcerpt === undefined
                ? {}
                : { diagnostic: output.setup.outputExcerpt }),
            }
          : undefined,
    };
  });
}

/** One receipt, minus the fence and the timestamp the repository stamps from its own clock. */
type ReceiptInput =
  | { readonly step: 'worktree'; readonly receipt: Omit<WorkflowWorktreeReceipt, 'recordedAt'> }
  | { readonly step: 'setup'; readonly receipt: Omit<WorkflowSetupReceipt, 'recordedAt'> }
  | { readonly step: 'surface'; readonly receipt: Omit<WorkflowSurfaceReceipt, 'recordedAt'> };

/**
 * Records one allocation, and stops if the fence refuses.
 *
 * A receipt is written even under Cancel — it is evidence, not a decision — which is why a
 * `cancelled_evidence` result halts *after* the write rather than skipping it. Any other rejection
 * means this worker no longer owns the attempt, so it stops without writing anything else;
 * `receipt_already_recorded` is unreachable on a correct path, because every step reads its receipt
 * before acting, and halting on it makes the defect visible instead of overwriting real evidence.
 */
function recordReceipt(
  deps: Pick<PreparationDeps, 'runs'>,
  fence: ReturnType<typeof fenceOf>,
  input: ReceiptInput,
): Effect.Effect<void, PreparationHalt | SegmentFault> {
  return deps.runs.recordEnvironmentReceipt({ ...fence, ...input }).pipe(
    Effect.flatMap((result) => {
      if (!result.ok) return halt(`rejected:${result.rejection.kind}`);
      if (result.value === 'cancelled_evidence') return halt('cancelled_evidence');
      return Effect.void;
    }),
  );
}

/** The receipt shape for whatever the setup runner reported. */
function setupReceiptOf(
  result: Exclude<WorktreeSetupResult, { status: 'not_run' }>,
): Omit<WorkflowSetupReceipt, 'recordedAt'> {
  switch (result.status) {
    case 'skipped':
      return { status: 'skipped', reason: result.reason, setupRunId: null, failure: null };
    case 'succeeded':
      return { status: 'succeeded', reason: null, setupRunId: result.runId, failure: null };
    case 'failed':
      return {
        status: 'failed',
        reason: null,
        setupRunId: result.runId,
        failure: {
          hookIndex: result.failedHookIndex,
          hookType: result.failedHookType,
          message: result.message,
          exitCode: result.exitCode ?? null,
          outputExcerpt: result.outputExcerpt ?? null,
        },
      };
  }
}

/**
 * A database failure is infrastructure, so it propagates as a fault rather than becoming a record.
 *
 * Typed as the one error it actually recognizes rather than as the whole `SegmentFault` union: the
 * three owning services this guards cannot raise `PayloadPublishError`, and claiming otherwise would
 * mean a payload-store fault that did somehow arrive got recorded as a *preparation* failure instead
 * of propagating as infrastructure — a wrong fact on a retained record, arrived at silently.
 */
function isDatabaseFault(error: unknown): error is DatabaseError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { readonly _tag?: unknown })._tag === 'DatabaseError'
  );
}

/**
 * One owning-service refusal, sorted into the only two things it can be.
 *
 * Infrastructure propagates as a fault and leaves the attempt open for recovery; everything else is
 * this preparation's own recorded failure. Sorting it in one place is what keeps the two from
 * drifting apart across the three services preparation calls.
 */
function owningFailure(
  step: WorkflowEnvironmentStep,
  error: unknown,
  identities: { readonly worktreeId?: number | undefined; readonly branch?: string | undefined },
): Effect.Effect<never, PreparationError> {
  if (isDatabaseFault(error)) return Effect.fail(error);
  return fail({ step, ...mapWorkspaceFailure(error), ...identities });
}

/**
 * The owning services' vocabulary, mapped into preparation's.
 *
 * The catch-all reports `<_tag>/<code>: <message>` as the diagnostic rather than folding an
 * unexpected refusal into `git_failed`: a failure disguised as something it is not is the hardest
 * kind to debug from a bug report, and the tag is what tells a reader which service refused.
 */
function mapWorkspaceFailure(error: unknown): {
  readonly reason: WorkflowEnvironmentFailureReason;
  readonly message: string;
  readonly worktreeId?: number | undefined;
  readonly diagnostic?: string | undefined;
} {
  if (error instanceof GitCommandError) {
    return {
      reason: 'git_failed',
      message: `Git failed: ${error.args.join(' ')}`,
      diagnostic: error.stderr,
    };
  }
  if (error instanceof WorkspaceError) {
    const reason = workspaceErrorReason(error.code);
    // The worktree it names travels with it. A `worktree_exists` that cannot say *which* worktree
    // leaves the person with a collision and nowhere to look.
    const worktreeId = error.worktreeId === undefined ? {} : { worktreeId: error.worktreeId };
    if (reason) return { reason, message: error.message, ...worktreeId };
    return {
      reason: 'workspace_rejected',
      message: error.message,
      ...worktreeId,
      diagnostic: `${error._tag}/${error.code}: ${error.message}`,
    };
  }
  if (error instanceof WorktreeSetupError) {
    return error.code === 'setup_trust_required'
      ? { reason: 'setup_trust_required', message: error.message }
      : {
          reason: 'workspace_rejected',
          message: error.message,
          diagnostic: `${error._tag}/${error.code}: ${error.message}`,
        };
  }
  const tagged = error as { readonly _tag?: string; readonly message?: string };
  if (tagged._tag === 'WorktreeSetupRunError') {
    return { reason: 'setup_failed', message: tagged.message ?? 'Worktree setup failed.' };
  }
  const message = tagged.message ?? String(error);
  const code = (error as { readonly code?: string }).code;
  return {
    reason: 'workspace_rejected',
    message,
    diagnostic: `${tagged._tag ?? 'unknown'}${code === undefined ? '' : `/${code}`}: ${message}`,
  };
}

function workspaceErrorReason(
  code: WorkspaceError['code'],
): WorkflowEnvironmentFailureReason | null {
  switch (code) {
    case 'branch_exists':
      return 'branch_exists';
    case 'worktree_exists':
      return 'worktree_exists';
    case 'checkout_path_exists':
    case 'checkout_path_registered':
    // Raised by `prepareCheckoutParent`, a `mkdirSync` at allocation time that the read-only launch
    // preflight never reaches — which is why it lands here rather than as a launch collision.
    case 'checkout_parent_unavailable':
      return 'checkout_path_unavailable';
    case 'setup_trust_required':
      return 'setup_trust_required';
    case 'worktree_not_found':
      return 'worktree_missing';
    default:
      return null;
  }
}

/** The surfaces domain's rejections, mapped the same way and for the same reason. */
function surfaceRejection(
  error: unknown,
  worktreeId: number,
): {
  readonly reason: WorkflowEnvironmentFailureReason;
  readonly message: string;
  readonly worktreeId?: number | undefined;
  readonly surfaceId?: number | undefined;
  readonly diagnostic?: string | undefined;
} {
  if (error instanceof SurfaceError) {
    switch (error.code) {
      case 'worktree_not_found':
        return { reason: 'worktree_missing', message: error.message, worktreeId };
      case 'creation_key_mismatch':
        return {
          reason: 'surface_not_on_worktree',
          message: error.message,
          worktreeId,
          ...(error.surfaceId === undefined ? {} : { surfaceId: error.surfaceId }),
        };
      default:
        return {
          reason: 'workspace_rejected',
          message: error.message,
          diagnostic: `${error._tag}/${error.code}: ${error.message}`,
        };
    }
  }
  return mapWorkspaceFailure(error);
}
