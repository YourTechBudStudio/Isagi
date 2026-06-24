import { Cause, Effect } from 'effect';

import type { InternalRuntimeEventBusService } from '../runtime-events/index.js';
import type { WorkflowHeadlessService } from './headless.js';
import type { WorkflowRepositoryService, WorkflowResumePayload } from './repository.js';
import type { WorkflowWaitCondition } from './types.js';
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
}) {
  return Effect.gen(function* () {
    const subscription = yield* input.eventBus.subscribe({
      types: ['turn_ended', 'turn_failed', 'headless_op_completed', 'workflow_run_terminal'],
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
        yield* input.repository.failRun({
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
        wokeAny = true;
        continue;
      }
      const woke = yield* input.repository.wakeWaitingRun({
        runId: run.id,
        resumePayload: { kind: 'workflow', results: resolution.results },
      });
      wokeAny = wokeAny || woke;
    }
    if (wokeAny) yield* input.engine.poke;
  });
}

export function resolveHeadlessCompletion(input: {
  readonly repository: WorkflowRepositoryService;
  readonly engine: Pick<WorkflowEngineService, 'poke'>;
  readonly headless: WorkflowHeadlessService;
  readonly runId: number;
}) {
  return Effect.gen(function* () {
    const run = yield* input.repository.findRun(input.runId);
    if (!run || run.status !== 'waiting' || run.waitKind !== 'headless') return;
    const condition = parseHeadlessWaitCondition(run.waitCondition);
    if (!condition) return;
    const results = yield* input.headless.completedResults(condition);
    if (!results) return;
    const woke = yield* input.repository.wakeWaitingRun({
      runId: run.id,
      resumePayload: { kind: 'headless', results },
    });
    if (woke) {
      yield* input.headless.releaseOps({ opIds: condition.ops.map((op) => op.opId) });
      yield* input.engine.poke;
    }
  });
}

export function resolveTurnEdge(input: {
  readonly repository: WorkflowRepositoryService;
  readonly engine: Pick<WorkflowEngineService, 'poke'>;
  readonly edge: TurnEdge;
}) {
  return Effect.gen(function* () {
    const candidates = yield* input.repository.findWaitingTurnRuns({
      agentSessionId: input.edge.agentSessionId,
      harnessSessionId: input.edge.harnessSessionId,
    });
    let wokeAny = false;
    for (const run of candidates) {
      const condition = parseWaitCondition(run.waitCondition);
      if (!condition || !isSatisfied(condition, input.edge)) continue;
      const woke = yield* input.repository.wakeWaitingRun({
        runId: run.id,
        resumePayload: resumePayload(input.edge),
      });
      wokeAny = wokeAny || woke;
    }
    if (wokeAny) yield* input.engine.poke;
  });
}

// The watermark is start-anchored on `recordedAt` (there is no durable turn id).
// v1 deliberately matches on the *terminal* edge alone: any `turn_ended`/`turn_failed`
// at or after `afterT` for the pinned (agentSession, harnessSession) satisfies the
// wait. This is provably safe for the gate's spawn-then-await pattern, where the
// pinned session has no prior turn and `afterT` precedes its first-ever start.
//
// OWED before loop workflows land (await_impl -> await_verdict -> await_impl re-suspending
// on the same session): also require the matched terminal turn to be opened by a
// `turn_started` with `recordedAt >= afterT`, so a *previous* turn's end whose timestamp
// happens to fall at/after the new inject `T` cannot satisfy the new wait. The shared
// matcher is the right home for that gate when it arrives.
export function isSatisfied(condition: WorkflowWaitCondition, edge: TurnEdge) {
  return (
    condition.kind === 'turn' &&
    condition.agentSessionId === edge.agentSessionId &&
    condition.harnessSessionId === edge.harnessSessionId &&
    edge.recordedAt >= condition.afterT
  );
}

function resumePayload(edge: TurnEdge): WorkflowResumePayload {
  if (edge.type === 'turn_failed') {
    return {
      outcome: 'failed',
      recordedAt: edge.recordedAt,
      reason: edge.reason ?? 'unknown',
    };
  }
  return { outcome: 'ended', recordedAt: edge.recordedAt };
}

function parseWaitCondition(value: string | null): WorkflowWaitCondition | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as WorkflowWaitCondition;
    return parsed?.kind === 'turn' ? parsed : null;
  } catch {
    return null;
  }
}

function parseHeadlessWaitCondition(
  value: string | null,
): Extract<WorkflowWaitCondition, { readonly kind: 'headless' }> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as WorkflowWaitCondition;
    return parsed?.kind === 'headless' ? parsed : null;
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
