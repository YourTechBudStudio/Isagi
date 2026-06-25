// How a suspended run gets resolved. Two complementary paths:
//   - `continuePaused*`: the user-gated resume of a `paused` run. Asserts the
//     harness session pin (it may have drifted while paused) before resuming, or
//     re-arms the wait when it isn't satisfied yet.
//   - `reconcileArmed*`: live-path catch-up for the suspend-commit race. Reads the
//     ledger (source of truth) right after arming a wait and wakes the run if the
//     wait it just armed is already satisfied. Mirrors the resolver's edge matching
//     rather than the continue path's pin assertion — the pin was set moments ago in
//     the same process, so it cannot have drifted, and `wakeWaitingRun` is guarded by
//     `status = 'waiting'` so a concurrent resolver wake stays single-winner.

import { Effect, Either } from 'effect';

import type {
  AgentSessionArtifactsService,
  HarnessLedgerObserverService,
} from '../agent-sessions/index.js';
import type { InternalRuntimeEventBusService } from '../runtime-events/index.js';
import type { WorkspaceRepositoryService } from '../workspace/index.js';
import type { WorkflowEventLedgerService } from './event-ledger.service.js';
import type { WorkflowHeadlessService } from './headless.js';
import type { WorkflowRepositoryService } from './repository.js';
import {
  appendLifecycleBestEffort,
  failWorkflowRunAndPublish,
  stepErrorPayload,
  worktreePathForRun,
} from './run-failure.js';
import type { WorkflowRunRow, WorkflowWaitCondition } from './types.js';
import {
  findSatisfiedTerminalTurnEdge,
  parseHeadlessWaitCondition,
  parseTurnWaitCondition,
  parseWorkflowWaitCondition,
  resumePayload,
} from './wait-conditions.js';

export function continuePausedRun(input: {
  readonly run: WorkflowRunRow;
  readonly repository: WorkflowRepositoryService;
  readonly artifacts: AgentSessionArtifactsService;
  readonly observer: HarnessLedgerObserverService;
  readonly headless: WorkflowHeadlessService;
  readonly eventLedger: WorkflowEventLedgerService;
  readonly workspaceRepository: WorkspaceRepositoryService;
  readonly eventBus: InternalRuntimeEventBusService;
  readonly poke: Effect.Effect<void>;
}) {
  if (input.run.waitKind === null) {
    return input.repository
      .readyPausedRun({ runId: input.run.id })
      .pipe(Effect.zipRight(input.poke));
  }

  if (input.run.waitKind === 'turn') {
    return continuePausedTurnRun(input);
  }

  if (input.run.waitKind === 'user_continue' || input.run.waitKind === 'user_input') {
    return input.repository.rearmPausedRun(input.run.id);
  }

  if (input.run.waitKind === 'headless') {
    return continuePausedHeadlessRun(input);
  }

  if (input.run.waitKind === 'workflow') {
    return continuePausedWorkflowRun(input);
  }

  return failWorkflowRunAndPublish({
    repository: input.repository,
    eventBus: input.eventBus,
    eventLedger: input.eventLedger,
    run: input.run,
    error: {
      message: `Unsupported workflow continue wait_kind '${input.run.waitKind}'.`,
      context: { workflowRunId: input.run.id, waitKind: input.run.waitKind },
    },
    stateSnapshot: { stateJson: input.run.stateJson },
  });
}

function continuePausedWorkflowRun(input: {
  readonly run: WorkflowRunRow;
  readonly repository: WorkflowRepositoryService;
  readonly eventLedger: WorkflowEventLedgerService;
  readonly eventBus: InternalRuntimeEventBusService;
  readonly poke: Effect.Effect<void>;
}) {
  return Effect.gen(function* () {
    const condition = parseWorkflowWaitCondition(input.run);
    if (!condition) {
      yield* failWorkflowRunAndPublish({
        repository: input.repository,
        eventBus: input.eventBus,
        eventLedger: input.eventLedger,
        run: input.run,
        error: {
          message: `Workflow run ${input.run.id} has an invalid workflow wait_condition.`,
          context: { workflowRunId: input.run.id },
        },
        stateSnapshot: { stateJson: input.run.stateJson },
      });
      return;
    }
    const resolution = yield* input.repository.resolveWorkflowJoin(condition);
    if (resolution.status === 'pending') {
      yield* input.repository.rearmPausedRun(input.run.id);
      return;
    }
    if (resolution.status === 'missing') {
      yield* failWorkflowRunAndPublish({
        repository: input.repository,
        eventBus: input.eventBus,
        eventLedger: input.eventLedger,
        run: input.run,
        error: {
          message: `Workflow run ${input.run.id} is waiting on missing workflow run ${resolution.runId}.`,
          context: { workflowRunId: input.run.id, missingWorkflowRunId: resolution.runId },
        },
        stateSnapshot: { stateJson: input.run.stateJson },
      });
      yield* input.poke;
      return;
    }
    yield* input.repository.readyPausedRun({
      runId: input.run.id,
      resumePayload: { kind: 'workflow', results: resolution.results },
    });
    yield* appendLifecycleBestEffort(input.eventLedger, input.run, 'resumed');
    yield* input.poke;
  });
}

function continuePausedHeadlessRun(input: {
  readonly run: WorkflowRunRow;
  readonly repository: WorkflowRepositoryService;
  readonly headless: WorkflowHeadlessService;
  readonly workspaceRepository: WorkspaceRepositoryService;
  readonly eventLedger: WorkflowEventLedgerService;
  readonly eventBus: InternalRuntimeEventBusService;
  readonly poke: Effect.Effect<void>;
}) {
  return Effect.gen(function* () {
    const condition = parseHeadlessWaitCondition(input.run);
    if (!condition) {
      yield* failWorkflowRunAndPublish({
        repository: input.repository,
        eventBus: input.eventBus,
        eventLedger: input.eventLedger,
        run: input.run,
        error: {
          message: `Workflow run ${input.run.id} has an invalid headless wait_condition.`,
          context: { workflowRunId: input.run.id },
        },
        stateSnapshot: { stateJson: input.run.stateJson },
      });
      return;
    }
    const worktreePath = yield* worktreePathForRun(input.run, input.workspaceRepository).pipe(
      Effect.either,
    );
    if (Either.isLeft(worktreePath)) {
      yield* failWorkflowRunAndPublish({
        repository: input.repository,
        eventBus: input.eventBus,
        eventLedger: input.eventLedger,
        run: input.run,
        error: stepErrorPayload(worktreePath.left, input.run),
        stateSnapshot: { stateJson: input.run.stateJson },
      });
      return;
    }
    const results = yield* input.headless.completedResults(condition);
    if (results) {
      yield* input.repository.readyPausedRun({
        runId: input.run.id,
        resumePayload: { kind: 'headless', results },
      });
      yield* appendLifecycleBestEffort(input.eventLedger, input.run, 'resumed');
      yield* input.headless.releaseOps({ opIds: condition.ops.map((op) => op.opId) });
      yield* input.poke;
      return;
    }
    const reissued = yield* input.headless
      .reissue({
        runId: input.run.id,
        worktreePath: worktreePath.right,
        ops: condition.ops,
      })
      .pipe(Effect.either);
    if (Either.isLeft(reissued)) {
      yield* failWorkflowRunAndPublish({
        repository: input.repository,
        eventBus: input.eventBus,
        eventLedger: input.eventLedger,
        run: input.run,
        error: stepErrorPayload(reissued.left, input.run),
        stateSnapshot: { stateJson: input.run.stateJson },
      });
      return;
    }
    yield* input.repository.rearmPausedRun(input.run.id);
  });
}

function continuePausedTurnRun(input: {
  readonly run: WorkflowRunRow;
  readonly repository: WorkflowRepositoryService;
  readonly artifacts: AgentSessionArtifactsService;
  readonly observer: HarnessLedgerObserverService;
  readonly eventLedger: WorkflowEventLedgerService;
  readonly eventBus: InternalRuntimeEventBusService;
  readonly poke: Effect.Effect<void>;
}) {
  return Effect.gen(function* () {
    const condition = parseTurnWaitCondition(input.run);
    if (!condition) {
      yield* failWorkflowRunAndPublish({
        repository: input.repository,
        eventBus: input.eventBus,
        eventLedger: input.eventLedger,
        run: input.run,
        error: {
          message: `Workflow run ${input.run.id} has an invalid turn wait_condition.`,
          context: { workflowRunId: input.run.id },
        },
        stateSnapshot: { stateJson: input.run.stateJson },
      });
      return;
    }

    const metadata = yield* input.artifacts.readMetadata(condition.agentSessionId);
    const currentHarnessSessionId =
      metadata.status === 'valid' ? metadata.metadata.harnessSessionId : null;
    if (currentHarnessSessionId !== condition.harnessSessionId) {
      yield* failWorkflowRunAndPublish({
        repository: input.repository,
        eventBus: input.eventBus,
        eventLedger: input.eventLedger,
        run: input.run,
        error: {
          message: `Workflow run ${input.run.id} cannot continue: harness session pin mismatch.`,
          context: {
            workflowRunId: input.run.id,
            agentSessionId: condition.agentSessionId,
            expectedHarnessSessionId: condition.harnessSessionId,
            currentHarnessSessionId,
            metadataStatus: metadata.status,
          },
        },
        stateSnapshot: { stateJson: input.run.stateJson },
      });
      return;
    }

    const edges = yield* input.observer.getTurnEdges(condition.agentSessionId);
    const terminalEdge = findSatisfiedTerminalTurnEdge(condition, edges);
    if (!terminalEdge) {
      yield* input.repository.rearmPausedRun(input.run.id);
      return;
    }

    yield* input.repository.readyPausedRun({
      runId: input.run.id,
      resumePayload: resumePayload(terminalEdge),
    });
    yield* appendLifecycleBestEffort(input.eventLedger, input.run, 'resumed');
    yield* input.poke;
  });
}

export function reconcileArmedTurnWait(input: {
  readonly run: WorkflowRunRow;
  readonly condition: Extract<WorkflowWaitCondition, { readonly kind: 'turn' }>;
  readonly repository: WorkflowRepositoryService;
  readonly observer: HarnessLedgerObserverService;
  readonly eventLedger: WorkflowEventLedgerService;
  readonly poke: Effect.Effect<void>;
}) {
  return Effect.gen(function* () {
    const edges = yield* input.observer.getTurnEdges(input.condition.agentSessionId);
    const edge = findSatisfiedTerminalTurnEdge(input.condition, edges);
    if (edge) {
      const woke = yield* input.repository.wakeWaitingRun({
        runId: input.run.id,
        resumePayload: resumePayload(edge),
      });
      if (woke) {
        yield* appendLifecycleBestEffort(input.eventLedger, input.run, 'resumed');
        yield* input.poke;
      }
      return;
    }
  });
}

export function reconcileArmedHeadlessWait(input: {
  readonly run: WorkflowRunRow;
  readonly condition: Extract<WorkflowWaitCondition, { readonly kind: 'headless' }>;
  readonly repository: WorkflowRepositoryService;
  readonly headless: WorkflowHeadlessService;
  readonly eventLedger: WorkflowEventLedgerService;
  readonly poke: Effect.Effect<void>;
}) {
  return Effect.gen(function* () {
    const results = yield* input.headless.completedResults(input.condition);
    if (!results) return;
    const woke = yield* input.repository.wakeWaitingRun({
      runId: input.run.id,
      resumePayload: { kind: 'headless', results },
    });
    if (woke) {
      yield* appendLifecycleBestEffort(input.eventLedger, input.run, 'resumed');
      yield* input.headless.releaseOps({ opIds: input.condition.ops.map((op) => op.opId) });
      yield* input.poke;
    }
  });
}

export function reconcileArmedWorkflowWait(input: {
  readonly run: WorkflowRunRow;
  readonly condition: Extract<WorkflowWaitCondition, { readonly kind: 'workflow' }>;
  readonly repository: WorkflowRepositoryService;
  readonly eventBus: InternalRuntimeEventBusService;
  readonly eventLedger: WorkflowEventLedgerService;
  readonly poke: Effect.Effect<void>;
}) {
  return Effect.gen(function* () {
    const resolution = yield* input.repository.resolveWorkflowJoin(input.condition);
    if (resolution.status === 'pending') return;
    if (resolution.status === 'missing') {
      yield* failWorkflowRunAndPublish({
        repository: input.repository,
        eventBus: input.eventBus,
        eventLedger: input.eventLedger,
        run: input.run,
        error: {
          message: `Workflow run ${input.run.id} is waiting on missing workflow run ${resolution.runId}.`,
          context: { workflowRunId: input.run.id, missingWorkflowRunId: resolution.runId },
        },
        stateSnapshot: { stateJson: input.run.stateJson },
      });
      yield* input.poke;
      return;
    }
    const woke = yield* input.repository.wakeWaitingRun({
      runId: input.run.id,
      resumePayload: { kind: 'workflow', results: resolution.results },
    });
    if (woke) {
      yield* appendLifecycleBestEffort(input.eventLedger, input.run, 'resumed');
      yield* input.poke;
    }
  });
}
