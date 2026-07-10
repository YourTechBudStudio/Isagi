// Shared failure, lifecycle-append, and error-shaping helpers used by the engine
// layer, the continue/resume paths, and the live-path reconcilers. Kept in one
// leaf module so those callers share a single failure/lifecycle surface without a
// dependency cycle back into the layer.

import { Effect } from 'effect';

import type { WorkflowLifecycleEvent, WorkflowLogLevelDto } from '@isagi/contracts';

import { runtimeDiagnosticsEnabled } from '../diagnostics/phase.js';
import type { InternalRuntimeEventBusService } from '../runtime-events/index.js';
import type { WorkspaceRepositoryService } from '../workspace/index.js';
import {
  type WorkflowEventLedgerService,
  workflowEventLedgerWarningPayload,
} from './event-ledger.service.js';
import type { WorkflowRepositoryService, WorkflowRunErrorPayload } from './repository.js';
import { WorkflowEngineError, type WorkflowRunRow } from './types.js';
import { WorkflowUserInputValidationError } from './user-input.js';

export function failWorkflowRunAndPublish(input: {
  readonly repository: WorkflowRepositoryService;
  readonly eventBus: InternalRuntimeEventBusService;
  readonly eventLedger: WorkflowEventLedgerService;
  readonly run: WorkflowRunRow;
  readonly error: WorkflowRunErrorPayload;
  readonly stateSnapshot: { readonly state: unknown } | { readonly stateJson: string };
}) {
  return input.repository
    .failNonTerminalRun({
      runId: input.run.id,
      error: input.error,
      stateSnapshot: input.stateSnapshot,
      thrown: true,
    })
    .pipe(Effect.zipRight(appendLifecycleBestEffort(input.eventLedger, input.run, 'failed')))
    .pipe(Effect.zipRight(publishWorkflowRunTerminal(input.eventBus, input.run.id, 'failed')));
}

export function appendLifecycleBestEffort(
  eventLedger: WorkflowEventLedgerService,
  run: WorkflowRunRow,
  event: WorkflowLifecycleEvent,
) {
  return eventLedger
    .append({
      runId: run.id,
      rootRunId: run.rootRunId,
      surfaceId: run.surfaceId,
      event: { type: 'lifecycle', event },
    })
    .pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => {
          console.warn('[runtime] Workflow lifecycle append failed', {
            op: 'lifecycle',
            lifecycle: event,
            ...workflowEventLedgerWarningPayload(error),
          });
        }),
      ),
      Effect.asVoid,
    );
}

export function appendInternalWorkflowLogBestEffort(
  eventLedger: WorkflowEventLedgerService | undefined,
  run: WorkflowRunRow,
  level: WorkflowLogLevelDto,
  message: string,
) {
  if (!eventLedger) return Effect.void;
  // Debug logs are operator-only diagnostics. Skip the disk append + bus publish
  // unless runtime diagnostics are enabled, so ordinary runs don't accrete granular
  // setup/spawn traces in the ledger (and the user-facing WorkflowBar that mirrors
  // it). The info-level lifecycle narrative below stays always-on.
  if (level === 'debug' && !runtimeDiagnosticsEnabled()) return Effect.void;
  return eventLedger
    .append({
      runId: run.id,
      rootRunId: run.rootRunId,
      surfaceId: run.surfaceId,
      event: { type: 'log', level, message },
    })
    .pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => {
          console.warn('[runtime] Workflow internal log append failed', {
            op: 'internal-log',
            level,
            ...workflowEventLedgerWarningPayload(error),
          });
        }),
      ),
      Effect.asVoid,
    );
}

export function publishWorkflowRunTerminal(
  eventBus: InternalRuntimeEventBusService,
  runId: number,
  status: 'done' | 'failed',
) {
  return eventBus.publish({ type: 'workflow_run_terminal', runId, status });
}

export function worktreePathForRun(
  run: WorkflowRunRow,
  workspaceRepository: WorkspaceRepositoryService,
) {
  return Effect.gen(function* () {
    if (run.worktreeId === null) {
      return yield* Effect.fail(
        new WorkflowEngineError({
          code: 'worktree_not_found',
          message: `Workflow run ${run.id} has no worktree_id.`,
          workflowRunId: run.id,
        }),
      );
    }
    const worktree = yield* workspaceRepository.findWorktree(run.worktreeId);
    if (!worktree) {
      return yield* Effect.fail(
        new WorkflowEngineError({
          code: 'worktree_not_found',
          message: `Worktree ${run.worktreeId} for workflow run ${run.id} was not found.`,
          workflowRunId: run.id,
          worktreeId: run.worktreeId,
        }),
      );
    }
    return worktree.path;
  });
}

export function findRunOrFail(repository: WorkflowRepositoryService, runId: number) {
  return Effect.gen(function* () {
    const run = yield* repository.findRun(runId);
    if (run) return run;
    return yield* Effect.fail(
      new WorkflowEngineError({
        code: 'workflow_run_not_found',
        message: `Workflow run ${runId} was not found.`,
        workflowRunId: runId,
      }),
    );
  });
}

export function userInputError(cause: unknown, runId: number) {
  if (cause instanceof WorkflowUserInputValidationError) {
    return new WorkflowEngineError({
      code: 'workflow_user_input_invalid',
      message: cause.message,
      workflowRunId: runId,
    });
  }
  return new WorkflowEngineError({
    code: 'workflow_user_input_invalid',
    message: errorMessage(cause),
    workflowRunId: runId,
  });
}

export function unknownWorkflowError(
  workflowKey: string,
  knownWorkflowKeys: readonly string[],
): WorkflowRunErrorPayload {
  return {
    message: unknownWorkflowMessage(workflowKey, knownWorkflowKeys),
    context: { workflowKey, knownWorkflowKeys },
  };
}

export function unknownWorkflowMessage(workflowKey: string, knownWorkflowKeys: readonly string[]) {
  const known = knownWorkflowKeys.length > 0 ? knownWorkflowKeys.join(', ') : '(none)';
  return `Unknown workflow_key '${workflowKey}'; known: ${known}`;
}

export function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

export function stepErrorPayload(cause: unknown, run: WorkflowRunRow): WorkflowRunErrorPayload {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  return {
    message: error.message,
    stack: error.stack,
    context: { workflowRunId: run.id, workflowKey: run.workflowKey, ...taggedErrorContext(cause) },
  };
}

// Preserve a failing step's tagged-error identity as queryable fields rather than
// only as text baked into `message`, so a remotely reported failed run can be
// triaged by `_tag`/`code`. Best-effort: a verb rejection arrives wrapped in an
// Effect `FiberFailure` and surfaces no tag here, but a directly thrown tagged
// error (or a future structured throw) does, and the extra fields never hurt.
export function taggedErrorContext(cause: unknown): Record<string, unknown> {
  if (!cause || typeof cause !== 'object') return {};
  const context: Record<string, unknown> = {};
  const tag = (cause as { readonly _tag?: unknown })['_tag'];
  const code = (cause as { readonly code?: unknown }).code;
  const reason = (cause as { readonly reason?: unknown }).reason;
  if (typeof tag === 'string') context.errorTag = tag;
  if (typeof code === 'string') context.errorCode = code;
  if (typeof reason === 'string') context.errorReason = reason;
  return context;
}
