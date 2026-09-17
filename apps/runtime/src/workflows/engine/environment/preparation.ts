import { Effect } from 'effect';

import type { DatabaseError } from '../../../persistence/index.js';
import type { PayloadPublishError } from '../../persistence/payload-store.js';
import type { WorkflowRunPreparationRecord } from '../../persistence/records.js';
import { WorkflowEngineError } from '../../types.js';
import type { PreparationContext, PreparationDeps } from './types.js';

/**
 * --- phase 06 stand-in, replaced by phase 07 ------------------------------------------------
 *
 * The real `prepareEnvironment` (program design §4.4) is a four-step segment — worktree, setup,
 * surface, commit — where each step reads its receipt, reuses or acts through an owning service, and
 * writes a receipt for what it allocated. Phase 07 builds it and forks it into the engine scope.
 *
 * This stands in for exactly the part of it that phase 06 can honestly perform: **nothing is
 * allocated**, so only a placement that reuses an existing worktree *and* an existing surface can
 * reach the commit. It exists so the engine, read-model and waits suites stay green across the one
 * phase between "a placement is chosen" and "a placement is prepared" — without which a real
 * regression in the most central transaction in the repository would be indistinguishable from
 * inherited debt.
 *
 * Two properties make it a stand-in rather than a second placement path, and phase 07 must not lose
 * either:
 *
 * - it commits the **resolved** destination, read back from the durable preparation row, never the
 *   origin. Phase 06's selection and validation are genuinely exercised, not bypassed.
 * - a `create` choice **fails the claimed attempt through the fence** and says it is unimplemented.
 *   It never silently succeeds, and it never abandons the attempt: once `createRun` has returned,
 *   the run and its claimed attempt exist and no other party will ever collect them — the dispatcher
 *   deliberately never claims this segment.
 *
 * **To remove it:** phase 07 replaces this function's body. The two bindings that call it are
 * `runPreparation` in `engine/interpreter.service.ts` and in `engine/test-support.ts`; per §3.6 they
 * become `Effect.forkIn(prepareEnvironment(prepDeps, ctx), engineScope).pipe(Effect.flatMap(Fiber.join))`.
 *
 * ---------------------------------------------------------------------------------------------
 */
export function prepareEnvironment(
  deps: Pick<PreparationDeps, 'runs' | 'workspace' | 'owner' | 'ownerIncarnation' | 'poke'>,
  ctx: PreparationContext,
): Effect.Effect<void, WorkflowEngineError | DatabaseError | PayloadPublishError> {
  return Effect.gen(function* () {
    const fence = {
      runId: ctx.run.id,
      attemptId: ctx.attempt.id,
      owner: deps.owner,
      ownerIncarnation: deps.ownerIncarnation,
    };

    const prep = yield* deps.runs.findPreparation(ctx.run.id);
    if (!prep) {
      // Defensive: `createRun` writes the preparation row in the same transaction as the run.
      return yield* closeAndFail(deps, fence, {
        message: `Run ${ctx.run.id} has no preparation record.`,
        code: 'workflow_load_failed',
      });
    }

    const unsupported = unsupportedChoice(prep);
    if (unsupported) {
      return yield* closeAndFail(deps, fence, {
        message: `Preparing a ${unsupported} is not implemented until phase 07; nothing was allocated.`,
        code: 'workflow_load_failed',
      });
    }

    const destination = yield* resolveReuseDestination(deps, ctx, prep);
    if (!destination.ok) {
      return yield* closeAndFail(deps, fence, destination);
    }

    const committed = yield* deps.runs.commitEnvironmentPreparation({
      ...fence,
      destination: destination.value,
    });

    if (!committed.ok) {
      const busy = committed.rejection.kind === 'surface_busy' ? committed.rejection : null;
      return yield* closeAndFail(deps, fence, {
        message: busy
          ? `Surface ${destination.value.surfaceId} already has a workflow attached.`
          : `The run could not be placed: ${committed.rejection.kind}.`,
        code: busy ? 'workflow_surface_attached' : 'workflow_load_failed',
        // Structured only for the one rejection that is an operational condition rather than a
        // defect. `workflowEnvironmentFailureReasonSchema` has no honest literal for a
        // `position_mismatch`, and inventing one would put a wrong fact on a retained record.
        ...(busy
          ? {
              detail: {
                step: 'commit' as const,
                reason: 'surface_busy' as const,
                surfaceId: destination.value.surfaceId,
                occupyingRunId: busy.runId,
              },
              activeWorkflowRunId: busy.runId,
              surfaceId: destination.value.surfaceId,
            }
          : {}),
      });
    }

    // A cancelled commit writes nothing and leaves the run terminal; there is nothing to wake.
    if (committed.value === 'cancelled_evidence') return;

    yield* deps.poke;
  });
}

/** Which allocation this stand-in cannot perform, if any. */
function unsupportedChoice(prep: WorkflowRunPreparationRecord): string | null {
  if (prep.request.worktree.kind === 'create') return 'newly created worktree';
  if (prep.request.surface.kind === 'create') return 'newly created surface';
  return null;
}

/**
 * The destination a reuse-only placement lands on, read back from the durable record.
 *
 * Deliberately re-read rather than carried in memory from `resolvePlacement`: it is the same thing
 * phase 07's segment does on every attempt, and it proves the row round-trips what the launch
 * decided.
 */
function resolveReuseDestination(
  deps: Pick<PreparationDeps, 'workspace'>,
  ctx: PreparationContext,
  prep: WorkflowRunPreparationRecord,
): Effect.Effect<
  | {
      readonly ok: true;
      readonly value: { worktreeId: number; worktreePath: string; surfaceId: number };
    }
  | {
      readonly ok: false;
      readonly message: string;
      readonly code: 'workflow_environment_unavailable';
    },
  DatabaseError
> {
  return Effect.gen(function* () {
    const worktreeId =
      prep.request.worktree.kind === 'existing'
        ? prep.request.worktree.worktreeId
        : ctx.run.origin.worktreeId;
    const surfaceId =
      prep.request.surface.kind === 'existing'
        ? prep.request.surface.surfaceId
        : ctx.run.origin.surfaceId;

    // The origin columns are nullable because retained history outlives the rows it names (ADR
    // 0006). A `current` choice that can no longer say what "current" was is unpreparable, which is
    // exactly `workflow_environment_unavailable`.
    if (worktreeId === null || surfaceId === null) {
      return {
        ok: false as const,
        message: `Run ${ctx.run.id} no longer records the environment it was launched from.`,
        code: 'workflow_environment_unavailable' as const,
      };
    }

    const row = yield* deps.workspace.findWorktree(worktreeId);
    if (!row) {
      return {
        ok: false as const,
        message: `Worktree ${worktreeId} is no longer there.`,
        code: 'workflow_environment_unavailable' as const,
      };
    }
    return { ok: true as const, value: { worktreeId: row.id, worktreePath: row.path, surfaceId } };
  });
}

/**
 * Fail the claimed attempt, then tell the caller.
 *
 * Both halves are required. The fence write is what closes the run — explicitly failed, ownership
 * released, attempt ended — and the raised error is what stops a refused launch from answering as
 * though it had succeeded. The error carries `workflowRunId` so the caller gets a handle on the
 * retained run rather than only being told no.
 */
function closeAndFail(
  deps: Pick<PreparationDeps, 'runs' | 'owner' | 'ownerIncarnation'>,
  fence: { runId: number; attemptId: number; owner: string; ownerIncarnation: string },
  failure: {
    readonly message: string;
    readonly code: WorkflowEngineError['code'];
    readonly detail?: Record<string, unknown> | undefined;
    readonly activeWorkflowRunId?: number | undefined;
    readonly surfaceId?: number | undefined;
  },
): Effect.Effect<never, WorkflowEngineError | DatabaseError | PayloadPublishError> {
  return Effect.gen(function* () {
    yield* deps.runs.failSegment({
      ...fence,
      code: 'environment_preparation_failed',
      message: failure.message,
      ...(failure.detail ? { detail: { value: failure.detail } } : {}),
    });
    return yield* Effect.fail(
      new WorkflowEngineError({
        code: failure.code,
        message: failure.message,
        workflowRunId: fence.runId,
        ...(failure.activeWorkflowRunId === undefined
          ? {}
          : { activeWorkflowRunId: failure.activeWorkflowRunId }),
        ...(failure.surfaceId === undefined ? {} : { surfaceId: failure.surfaceId }),
      }),
    );
  });
}
