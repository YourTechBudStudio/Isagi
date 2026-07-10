import { Cause, Effect } from 'effect';

import type { HarnessLedgerObserverService } from '../agent-sessions/index.js';
import type { InternalRuntimeEventBusService } from '../runtime-events/index.js';
import {
  type WorkflowEventLedgerService,
  workflowEventLedgerWarningPayload,
} from './event-ledger.service.js';
import type { WorkflowHeadlessService } from './headless.js';
import type { WorkflowRepositoryService } from './repository.js';
import { appendInternalWorkflowLogBestEffort } from './run-failure.js';
import type { WorkflowWaitCondition } from './types.js';
import {
  findSatisfiedTerminalTurnEdge,
  isTerminalTurnEdge,
  parseTurnWaitCondition,
  resumePayload,
} from './wait-conditions.js';
import type { WorkflowEngineService } from './workflow-engine.service.js';

type TurnEdge = {
  readonly type: 'turn_ended' | 'turn_failed';
  readonly agentSessionId: number;
  readonly harnessSessionId: string;
  readonly recordedAt: string;
  readonly reason?: string | undefined;
};

export function startWorkflowResolver(input: {
  readonly repository: WorkflowRepositoryService;
  readonly engine: Pick<WorkflowEngineService, 'poke'>;
  readonly eventBus: InternalRuntimeEventBusService;
  readonly headless: WorkflowHeadlessService;
  readonly observer: HarnessLedgerObserverService;
  readonly eventLedger?: WorkflowEventLedgerService | undefined;
}) {
  return Effect.gen(function* () {
    const subscription = yield* input.eventBus.subscribe({
      types: [
        'turn_ended',
        'turn_failed',
        'headless_op_completed',
        'workflow_run_terminal',
        'surface_changed',
      ],
    });
    yield* Effect.addFinalizer(() => subscription.unsubscribe);
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const event = yield* subscription.take;
          if (event.type === 'turn_ended' || event.type === 'turn_failed') {
            yield* resolveTurnEdge({ ...input, edge: event });
            return;
          }
          if (event.type === 'headless_op_completed') {
            yield* resolveHeadlessCompletion({ ...input, runId: event.runId });
            return;
          }
          if (event.type === 'workflow_run_terminal') {
            yield* resolveWorkflowTerminal({ ...input, childRunId: event.runId });
            return;
          }
          if (event.type === 'surface_changed' && event.payload.change === 'deleted') {
            // The surface was deleted out from under any workflow it owned; tear the
            // now-surfaceless run tree down eagerly instead of leaving it to linger
            // until the next process restart's orphan sweep.
            yield* input.eventLedger?.sweepSurfaceDeletedRuns ?? Effect.void;
          }
        }).pipe(
          Effect.catchAllCause((cause) =>
            Effect.sync(() => {
              console.warn('[runtime] Workflow resolver failed', Cause.pretty(cause));
            }),
          ),
        ),
      ),
    );
  });
}

export function resolveWorkflowTerminal(input: {
  readonly repository: WorkflowRepositoryService;
  readonly engine: Pick<WorkflowEngineService, 'poke'>;
  readonly eventBus: InternalRuntimeEventBusService;
  readonly eventLedger?: WorkflowEventLedgerService | undefined;
  readonly childRunId: number;
}) {
  return Effect.gen(function* () {
    const candidates = yield* input.repository.findWaitingWorkflowRuns(input.childRunId);
    let wokeAny = false;
    for (const run of candidates) {
      const condition = parseWorkflowWaitCondition(run.waitCondition);
      if (!condition) continue;
      const resolution = yield* input.repository.resolveWorkflowJoin(condition);
      if (resolution.status === 'pending') continue;
      if (resolution.status === 'missing') {
        // The waiting run must be failed with the non-terminal-guarded update, not
        // `failRun` (which only matches `status = 'running'`). `run` here comes from
        // `findWaitingWorkflowRuns`, so it is `waiting`; `failRun` would match no row
        // and leave the run `waiting` while we still publish a `failed` terminal +
        // lifecycle event — a silent status/log inconsistency. This mirrors the
        // `failNonTerminalRun` path used by the reconcile/continue siblings.
        yield* input.repository.failNonTerminalRun({
          runId: run.id,
          error: {
            message: `Workflow run ${run.id} is waiting on missing workflow run ${resolution.runId}.`,
            context: { workflowRunId: run.id, missingWorkflowRunId: resolution.runId },
          },
          stateSnapshot: { stateJson: run.stateJson },
          thrown: true,
        });
        yield* input.eventBus.publish({
          type: 'workflow_run_terminal',
          runId: run.id,
          status: 'failed',
        });
        yield* appendLifecycleBestEffort(input.eventLedger, run, 'failed');
        wokeAny = true;
        continue;
      }
      const woke = yield* input.repository.wakeWaitingRun({
        runId: run.id,
        resumePayload: { kind: 'workflow', results: resolution.results },
      });
      if (woke) {
        yield* appendInternalWorkflowLogBestEffort(
          input.eventLedger,
          run,
          'info',
          `Workflow child run ${input.childRunId} completed; run ${run.id} is ready to resume.`,
        );
        yield* appendLifecycleBestEffort(input.eventLedger, run, 'resumed');
      }
      wokeAny = wokeAny || woke;
    }
    if (wokeAny) yield* input.engine.poke;
  });
}

export function resolveHeadlessCompletion(input: {
  readonly repository: WorkflowRepositoryService;
  readonly engine: Pick<WorkflowEngineService, 'poke'>;
  readonly headless: WorkflowHeadlessService;
  readonly eventLedger?: WorkflowEventLedgerService | undefined;
  readonly runId: number;
}) {
  return Effect.gen(function* () {
    const run = yield* input.repository.findRun(input.runId);
    if (!run || run.status !== 'waiting' || run.waitKind !== 'headless_agent') return;
    const condition = parseHeadlessWaitCondition(run.waitCondition);
    if (!condition) return;
    const results = yield* input.headless.completedResults(condition);
    if (!results) return;
    const woke = yield* input.repository.wakeWaitingRun({
      runId: run.id,
      resumePayload: { kind: 'headless_agent', results },
    });
    if (woke) {
      yield* appendInternalWorkflowLogBestEffort(
        input.eventLedger,
        run,
        'info',
        `Headless operation completed for run ${run.id}; run is ready to resume.`,
      );
      yield* appendLifecycleBestEffort(input.eventLedger, run, 'resumed');
      yield* input.headless.releaseOps({ opIds: condition.ops.map((op) => op.opId) });
      yield* input.engine.poke;
    }
  });
}

export function resolveTurnEdge(input: {
  readonly repository: WorkflowRepositoryService;
  readonly engine: Pick<WorkflowEngineService, 'poke'>;
  readonly observer: HarnessLedgerObserverService;
  readonly eventLedger?: WorkflowEventLedgerService | undefined;
  readonly edge: TurnEdge;
}) {
  return Effect.gen(function* () {
    const edges = yield* input.observer.getTurnEdges(input.edge.agentSessionId);
    if (!edges.some(isTerminalTurnEdge)) return;
    const candidates = yield* input.repository.findWaitingAgentTurnRuns(input.edge.agentSessionId);
    let wokeAny = false;
    for (const run of candidates) {
      const condition = parseTurnWaitCondition(run);
      if (!condition) continue;
      const terminalEdge = findSatisfiedTerminalTurnEdge(condition, edges);
      if (!terminalEdge) continue;
      const woke = yield* input.repository.wakeWaitingRun({
        runId: run.id,
        resumePayload: resumePayload(terminalEdge),
      });
      if (woke) {
        yield* appendInternalWorkflowLogBestEffort(
          input.eventLedger,
          run,
          'info',
          `Agent turn ${terminalEdge.type} for session ${terminalEdge.agentSessionId}; run ${run.id} is ready to resume.`,
        );
        yield* appendLifecycleBestEffort(input.eventLedger, run, 'resumed');
      }
      wokeAny = wokeAny || woke;
    }
    if (wokeAny) yield* input.engine.poke;
  });
}

function appendLifecycleBestEffort(
  eventLedger: WorkflowEventLedgerService | undefined,
  run: import('./types.js').WorkflowRunRow,
  event: import('@isagi/contracts').WorkflowLifecycleEvent,
) {
  if (!eventLedger) return Effect.void;
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
          console.warn('[runtime] Workflow resolver lifecycle append failed', {
            op: 'lifecycle',
            lifecycle: event,
            ...workflowEventLedgerWarningPayload(error),
          });
        }),
      ),
      Effect.asVoid,
    );
}

function parseHeadlessWaitCondition(
  value: string | null,
): Extract<WorkflowWaitCondition, { readonly kind: 'headless_agent' }> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as WorkflowWaitCondition;
    return parsed?.kind === 'headless_agent' ? parsed : null;
  } catch {
    return null;
  }
}

function parseWorkflowWaitCondition(
  value: string | null,
): Extract<WorkflowWaitCondition, { readonly kind: 'workflow' }> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as WorkflowWaitCondition;
    return parsed?.kind === 'workflow' && Array.isArray(parsed.runIds) ? parsed : null;
  } catch {
    return null;
  }
}
