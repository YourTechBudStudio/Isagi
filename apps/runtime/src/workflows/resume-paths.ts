// How a suspended run gets resolved. Two complementary paths:
//   - `continueResumed*`: the user-gated continuation of a newly unpaused run. Asserts the
//     harness session pin (it may have drifted while paused) before resuming, or
//     re-arms the wait when it isn't satisfied yet.
//   - `reconcileArmed*`: live-path catch-up for the suspend-commit race. Reads the
//     ledger (source of truth) right after arming a wait and wakes the run if the
//     wait it just armed is already satisfied. Mirrors the resolver's edge matching
//     rather than the continue path's pin assertion — the pin was set moments ago in
//     the same process, so it cannot have drifted, and `wakeWaitingRun` is guarded by
//     `status = 'waiting'` so a concurrent resolver wake stays single-winner.

import { Effect, Either } from 'effect';

import type { HarnessLedgerObserverService } from '../agent-sessions/index.js';
import type { InternalRuntimeEventBusService } from '../runtime-events/index.js';
import type { WorkspaceRepositoryService } from '../workspace/index.js';
import type { WorkflowEventLedgerService } from './event-ledger.service.js';
import type { WorkflowHeadlessService } from './headless.js';
import type { WorkflowRepositoryService } from './repository.js';
import {
  appendLifecycleBestEffort,
  appendInternalWorkflowLogBestEffort,
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

export function continueResumedRun(input: {
  readonly run: WorkflowRunRow;
  readonly repository: WorkflowRepositoryService;
  readonly observer: HarnessLedgerObserverService;
  readonly headless: WorkflowHeadlessService;
  readonly eventLedger: WorkflowEventLedgerService;
  readonly workspaceRepository: WorkspaceRepositoryService;
  readonly eventBus: InternalRuntimeEventBusService;
  readonly poke: Effect.Effect<void>;
}) {
  if (input.run.status === 'running') {
    return appendInternalWorkflowLogBestEffort(
      input.eventLedger,
      input.run,
      'info',
      `Workflow run ${input.run.id} resumed while its current step was still executing; the latest artifact will be used at the next step boundary.`,
    );
  }

  if (input.run.waitKind === null) {
    if (input.run.status === 'ready') {
      return appendInternalWorkflowLogBestEffort(
        input.eventLedger,
        input.run,
        'info',
        `Workflow run ${input.run.id} is ready to continue after resume.`,
      );
    }
    return failWorkflowRunAndPublish({
      repository: input.repository,
      eventBus: input.eventBus,
      eventLedger: input.eventLedger,
      run: input.run,
      error: {
        message: `Workflow run ${input.run.id} resumed from ${input.run.status} without a wait condition.`,
        context: { workflowRunId: input.run.id, status: input.run.status },
      },
      stateSnapshot: { stateJson: input.run.stateJson },
    });
  }

  if (input.run.waitKind === 'agent_turn') {
    return continueResumedTurnRun(input);
  }

  if (input.run.waitKind === 'user_continue' || input.run.waitKind === 'user_input') {
    return input.repository
      .rearmResumedWait(input.run.id)
      .pipe(
        Effect.zipRight(
          appendInternalWorkflowLogBestEffort(
            input.eventLedger,
            input.run,
            'info',
            `Workflow run ${input.run.id} re-armed ${input.run.waitKind} wait after resume.`,
          ),
        ),
      );
  }

  if (input.run.waitKind === 'headless_agent') {
    return continueResumedHeadlessRun(input);
  }

  if (input.run.waitKind === 'workflow') {
    return continueResumedWorkflowRun(input);
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

function continueResumedWorkflowRun(input: {
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
      yield* input.repository.rearmResumedWait(input.run.id);
      yield* appendInternalWorkflowLogBestEffort(
        input.eventLedger,
        input.run,
        'info',
        `Workflow run ${input.run.id} re-armed workflow join wait after resume.`,
      );
      yield* reconcileArmedWorkflowWait({
        run: input.run,
        condition,
        repository: input.repository,
        eventBus: input.eventBus,
        eventLedger: input.eventLedger,
        poke: input.poke,
      });
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
    yield* input.repository.readyResumedWait({
      runId: input.run.id,
      resumePayload: { kind: 'workflow', results: resolution.results },
    });
    yield* appendInternalWorkflowLogBestEffort(
      input.eventLedger,
      input.run,
      'info',
      `Workflow join satisfied while continuing run ${input.run.id}; run is ready to resume.`,
    );
    yield* appendLifecycleBestEffort(input.eventLedger, input.run, 'resumed');
    yield* input.poke;
  });
}

function continueResumedHeadlessRun(input: {
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
      yield* input.repository.readyResumedWait({
        runId: input.run.id,
        resumePayload: { kind: 'headless_agent', results },
      });
      yield* appendInternalWorkflowLogBestEffort(
        input.eventLedger,
        input.run,
        'info',
        `Headless wait already satisfied while continuing run ${input.run.id}; run is ready to resume.`,
      );
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
    yield* input.repository.rearmResumedWait(input.run.id);
    yield* appendInternalWorkflowLogBestEffort(
      input.eventLedger,
      input.run,
      'info',
      `Workflow run ${input.run.id} reissued and re-armed headless wait after resume.`,
    );
    yield* reconcileArmedHeadlessWait({
      run: input.run,
      condition,
      repository: input.repository,
      headless: input.headless,
      eventLedger: input.eventLedger,
      poke: input.poke,
    });
  });
}

function continueResumedTurnRun(input: {
  readonly run: WorkflowRunRow;
  readonly repository: WorkflowRepositoryService;
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

    const edges = yield* input.observer.getTurnEdges(condition.agentSessionId);
    const terminalEdge = findSatisfiedTerminalTurnEdge(condition, edges);
    if (!terminalEdge) {
      yield* input.repository.rearmResumedWait(input.run.id);
      yield* appendInternalWorkflowLogBestEffort(
        input.eventLedger,
        input.run,
        'info',
        `Workflow run ${input.run.id} re-armed turn wait for agent session ${condition.agentSessionId} after resume.`,
      );
      yield* reconcileArmedTurnWait({
        run: input.run,
        condition,
        repository: input.repository,
        observer: input.observer,
        eventLedger: input.eventLedger,
        poke: input.poke,
      });
      return;
    }

    yield* input.repository.readyResumedWait({
      runId: input.run.id,
      resumePayload: resumePayload(terminalEdge),
    });
    yield* appendInternalWorkflowLogBestEffort(
      input.eventLedger,
      input.run,
      'info',
      `Turn wait satisfied while continuing run ${input.run.id}; run is ready to resume.`,
    );
    yield* appendLifecycleBestEffort(input.eventLedger, input.run, 'resumed');
    yield* input.poke;
  });
}

export function reconcileArmedTurnWait(input: {
  readonly run: WorkflowRunRow;
  readonly condition: Extract<WorkflowWaitCondition, { readonly kind: 'agent_turn' }>;
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
        yield* appendInternalWorkflowLogBestEffort(
          input.eventLedger,
          input.run,
          'info',
          `Turn wait satisfied during arm-time reconciliation for run ${input.run.id}; run is ready to resume.`,
        );
        yield* appendLifecycleBestEffort(input.eventLedger, input.run, 'resumed');
        yield* input.poke;
      }
      return;
    }
  });
}

export function reconcileArmedHeadlessWait(input: {
  readonly run: WorkflowRunRow;
  readonly condition: Extract<WorkflowWaitCondition, { readonly kind: 'headless_agent' }>;
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
      resumePayload: { kind: 'headless_agent', results },
    });
    if (woke) {
      yield* appendInternalWorkflowLogBestEffort(
        input.eventLedger,
        input.run,
        'info',
        `Headless wait satisfied during arm-time reconciliation for run ${input.run.id}; run is ready to resume.`,
      );
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
      yield* appendInternalWorkflowLogBestEffort(
        input.eventLedger,
        input.run,
        'info',
        `Workflow join satisfied during arm-time reconciliation for run ${input.run.id}; run is ready to resume.`,
      );
      yield* appendLifecycleBestEffort(input.eventLedger, input.run, 'resumed');
      yield* input.poke;
    }
  });
}
