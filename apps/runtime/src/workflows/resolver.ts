import { Cause, Effect } from 'effect';

import type { InternalRuntimeEventBusService } from '../runtime-events/index.js';
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
}) {
  return Effect.gen(function* () {
    const subscription = yield* input.eventBus.subscribe({
      types: ['turn_ended', 'turn_failed'],
    });
    yield* Effect.addFinalizer(() => subscription.unsubscribe);
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const event = yield* subscription.take;
          if (event.type !== 'turn_ended' && event.type !== 'turn_failed') return;
          yield* resolveTurnEdge({ ...input, edge: event });
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
