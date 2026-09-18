import type {
  WorkflowExecutionDto,
  WorkflowFrameDto,
  WorkflowOperationDto,
  WorkflowRunSummary,
  WorkflowRunTransitionDelta,
  WorkflowStructureDescriptorDto,
} from '@isagi/contracts';

import {
  workflowExecutionFixture,
  workflowFrameFixture,
  workflowOperationFixture,
  workflowSummaryFixture,
} from '../../../src/lib/workspace/workflow/test-support.js';

/**
 * One run, as the runtime would actually describe it.
 *
 * Every record here is a real DTO built from the shared fixtures, so the page exercises the
 * production data layer end to end rather than a plausible-looking stand-in. Ids, hashes and
 * capability names are invented but structurally honest: nothing is a canned string the components
 * could not have received from the API.
 */

export const RUN_ID = 77;
export const PIN_ONE = 'sha256:9f2c1abfixtureone';
export const PIN_TWO = 'sha256:4d81e07fixturetwo';

export type ScenarioKey =
  | 'ready'
  | 'running'
  | 'waiting_agent'
  | 'waiting_questions'
  | 'waiting_continue'
  | 'paused'
  | 'blocked_operation'
  | 'blocked_environment'
  | 'callback_failed'
  | 'routing_failed'
  | 'done'
  | 'authored_failure'
  | 'cancelled'
  | 'root_init_failed'
  | 'interrupted';

export const scenarioKeys: readonly ScenarioKey[] = [
  'ready',
  'running',
  'waiting_agent',
  'waiting_questions',
  'waiting_continue',
  'paused',
  'blocked_operation',
  'blocked_environment',
  'callback_failed',
  'routing_failed',
  'done',
  'authored_failure',
  'cancelled',
  'root_init_failed',
  // A run parked after a runtime restart: its callback's owner is gone, so its end is unknown.
  'interrupted',
];

export interface PayloadFixture {
  readonly mediaType: string;
  readonly byteSize: number;
  readonly value: unknown;
}

export interface FixtureWorld {
  readonly summary: WorkflowRunSummary;
  readonly descriptor: WorkflowStructureDescriptorDto;
  readonly artifactHash: string;
  readonly executions: readonly WorkflowExecutionDto[];
  readonly frames: readonly WorkflowFrameDto[];
  readonly operations: readonly WorkflowOperationDto[];
  readonly events: readonly WorkflowRunTransitionDelta[];
  readonly payloads: ReadonlyMap<string, PayloadFixture | 'missing' | 'corrupt'>;
}

// Anchored to when the page loaded, so a live scenario reads as a run that started a few minutes
// ago rather than one that has apparently been going since the fixture was written.
const base = Date.now() - 180_000;
export const at = (seconds: number): string => new Date(base + seconds * 1000).toISOString();

/* ── structure ─────────────────────────────────────────────────────────────────────────────── */

/**
 * The reviewed-document shape: collect, triage a person, then two independent review passes over one
 * reusable `review` graph, whose own `deep-check` step nests a third level.
 *
 * `review` being registered twice is the point. Two registrations of one definition must keep two
 * separate histories, and only a deeply nested fixture can show that a node three levels down is
 * still reachable and correctly addressed.
 */
export function descriptorFor(pin: string): WorkflowStructureDescriptorDto {
  const withRetryNode = pin === PIN_TWO;
  return {
    descriptorVersion: 1,
    workflowContractVersion: 3,
    rootGraphKey: 'release',
    graphs: [
      {
        key: 'release',
        title: 'Release check',
        stateFields: ['draft', 'verdict', 'notes'],
        entry: 'collect',
        nodes: [
          { id: 'collect', kind: 'operation', title: 'Collect changes' },
          { id: 'triage', kind: 'operation', title: 'Ask for direction' },
          { id: 'first-pass', kind: 'subgraph', graphKey: 'review' },
          { id: 'second-pass', kind: 'subgraph', graphKey: 'review' },
          // Adopted by the Retry in pin two. Before that it does not exist at all; after it, it is
          // a node that has never run.
          ...(withRetryNode ? [{ id: 'sign-off', kind: 'operation' as const }] : []),
        ],
        edges: [
          { id: 'after-collect', from: 'collect', to: ['triage'] },
          { id: 'after-triage', from: 'triage', to: ['first-pass', 'rejected'] },
          { id: 'after-first', from: 'first-pass', to: ['second-pass', 'shipped'] },
          {
            id: 'after-second',
            from: 'second-pass',
            // The second pin changes where this edge can go without changing its id, which is the
            // shape a layout identity derived from element keys alone could not tell apart.
            to: withRetryNode ? ['sign-off', 'rejected'] : ['shipped', 'rejected'],
          },
          ...(withRetryNode
            ? [{ id: 'after-sign-off', from: 'sign-off' as const, to: ['shipped'] }]
            : []),
        ],
        outcomes: [
          { id: 'shipped', kind: 'success', reason: 'Every check passed.' },
          { id: 'rejected', kind: 'failure', reason: 'The change was rejected.' },
        ],
      },
      {
        key: 'review',
        title: 'Review pass',
        stateFields: ['draft', 'findings'],
        entry: 'read',
        nodes: [
          { id: 'read', kind: 'operation' },
          { id: 'deep-check', kind: 'subgraph', graphKey: 'rules' },
        ],
        edges: [
          { id: 'after-read', from: 'read', to: ['deep-check'] },
          { id: 'after-deep-check', from: 'deep-check', to: ['accepted', 'read'] },
        ],
        outcomes: [{ id: 'accepted', kind: 'success' }],
      },
      {
        key: 'rules',
        title: 'Rule checks',
        stateFields: ['findings'],
        entry: 'scan',
        nodes: [
          { id: 'scan', kind: 'operation' },
          // The fourth level. Nesting this deep is what proves addressing, expansion and keyboard
          // reach do not quietly stop working a level or two down.
          { id: 'lint-pass', kind: 'subgraph', graphKey: 'lint' },
        ],
        edges: [
          { id: 'after-scan', from: 'scan', to: ['lint-pass'] },
          { id: 'after-lint', from: 'lint-pass', to: ['clean'] },
        ],
        outcomes: [{ id: 'clean', kind: 'success' }],
      },
      {
        key: 'lint',
        title: 'Lint',
        stateFields: ['findings'],
        entry: 'rules-run',
        nodes: [{ id: 'rules-run', kind: 'operation' }],
        edges: [{ id: 'after-rules-run', from: 'rules-run', to: ['linted'] }],
        outcomes: [{ id: 'linted', kind: 'success' }],
      },
    ],
  };
}

/* ── payloads ──────────────────────────────────────────────────────────────────────────────── */

const storedPayloads = new Map<string, PayloadFixture | 'missing' | 'corrupt'>([
  [
    'p:state-in',
    {
      mediaType: 'application/json',
      byteSize: 412,
      value: { draft: 'Bump the runtime to 0.0.4', verdict: null, notes: [] },
    },
  ],
  [
    'p:prompt',
    {
      mediaType: 'text/plain',
      byteSize: 2_180,
      value:
        'Review the diff below and report anything that would break a clean checkout.\n\nFocus on:\n- unbounded queries\n- secrets in logs\n- unchecked JSON parsing\n',
    },
  ],
  // Referenced by history, and the store cannot serve it. Distinct from a value never produced.
  ['p:gone', 'missing'],
  ['p:tampered', 'corrupt'],
]);

/* ── the run ───────────────────────────────────────────────────────────────────────────────── */

const placement = (available: boolean) => ({
  worktreeId: 12,
  worktreePath: '/work/isagi/.worktrees/release',
  surfaceId: 121,
  paneId: 1211,
  agentSessionId: 7,
  available,
});

interface BuildOptions {
  readonly scenario: ScenarioKey;
  readonly pin: string;
  /** A long run, for the pagination and virtualization the waterfall has to survive. */
  readonly longHistory: boolean;
  /** Extra operations on the triage visit, so the dock's paging is exercised. */
  readonly manyOperations: boolean;
}

export function buildWorld(options: BuildOptions): FixtureWorld {
  const { scenario, pin } = options;
  const repaired = pin === PIN_TWO;

  // A graph whose setup threw has no executions at all: the only thing that happened is the frame's
  // own entry segment, and the inspector has to be able to reach it.
  if (scenario === 'root_init_failed') {
    return {
      summary: summaryFor(scenario, pin, false),
      descriptor: descriptorFor(pin),
      artifactHash: pin,
      executions: [],
      frames: [
        workflowFrameFixture({
          frameId: 1,
          graphKey: 'release',
          entryArtifactHash: pin,
          depth: 0,
          status: 'initializing',
          enteredAt: at(0),
          executionCount: 0,
          parametersRef: { inline: { draft: null } },
          entry: {
            segmentKind: 'graph_entry',
            segmentRef: null,
            attemptCount: 1,
            startedAt: at(0),
            endedAt: at(0.4),
            endCertainty: 'observed',
            firstArtifactHash: pin,
            latestArtifactHash: pin,
            latestAttempt: {
              attemptId: 1,
              attemptIndex: 1,
              artifactHash: pin,
              status: 'failed',
              invocationKind: 'initial',
              failure: {
                code: 'graph_init_failed',
                message: "TypeError: cannot read property 'head' of undefined",
                detail: null,
              },
              recoveryMode: 'rerun_producer',
              producerArtifactHash: null,
            },
            priorFailures: [],
          },
        }),
      ],
      operations: [],
      events: [],
      payloads: storedPayloads,
    };
  }

  const frames: WorkflowFrameDto[] = [];
  const executions: WorkflowExecutionDto[] = [];
  const operations: WorkflowOperationDto[] = [];

  const rootFrame = workflowFrameFixture({
    frameId: 1,
    graphKey: 'release',
    entryArtifactHash: PIN_ONE,
    depth: 0,
    status: scenario === 'done' || scenario === 'authored_failure' ? 'completed' : 'active',
    enteredAt: at(0),
    stateRef: { payloadRef: 'p:state-in', byteSize: 412, mediaType: 'application/json' },
    executionCount: 4,
    ...(scenario === 'done' || scenario === 'authored_failure'
      ? {
          completedAt: at(180),
          output: {
            outcomeId: scenario === 'done' ? 'shipped' : 'rejected',
            outcomeKind: scenario === 'done' ? ('success' as const) : ('failure' as const),
            outcomeReason:
              scenario === 'done' ? 'Every check passed.' : 'Two rules failed on the second pass.',
            producedRef: { inline: { verdict: scenario === 'done' ? 'ship' : 'reject' } },
            producerArtifactHash: pin,
          },
        }
      : {}),
  });
  frames.push(rootFrame);

  // 1 · collect
  executions.push(
    workflowExecutionFixture({
      executionId: 101,
      frameId: 1,
      graphKey: 'release',
      nodeId: 'collect',
      displayName: '34 files across 6 packages',
      status: 'completed',
      startedAt: at(1),
      endedAt: at(3.4),
      callbackStartedAt: at(1),
      callbackEndedAt: at(3.4),
      attemptCount: 1,
      firstArtifactHash: PIN_ONE,
      latestArtifactHash: PIN_ONE,
      latestAttempt: attempt(1, PIN_ONE, 'succeeded'),
      routing: {
        edgeId: 'after-collect',
        attemptIndex: 1,
        chosen: 'triage',
        updateRef: { inline: { draft: 'Bump the runtime to 0.0.4' } },
        startedAt: at(3.4),
        endedAt: at(3.5),
        failure: null,
      },
      operationSummary: { count: 0, unresolved: 0, capabilities: [] },
      stateInRef: { payloadRef: 'p:state-in', byteSize: 412, mediaType: 'application/json' },
      candidateRef: { inline: { draft: 'Bump the runtime to 0.0.4' } },
      updateRef: { inline: { draft: 'Bump the runtime to 0.0.4' } },
      // Produced, and the store cannot read it back. The step still ran.
      stateOutRef: { payloadRef: 'p:gone', byteSize: 512, mediaType: 'application/json' },
    }),
  );

  // 2 · triage — a human wait *and* real operations, which must coexist.
  const triageWaiting =
    scenario === 'waiting_questions' ||
    scenario === 'waiting_continue' ||
    scenario === 'paused' ||
    scenario === 'ready';
  const triageOperations = options.manyOperations ? 7 : 2;
  executions.push(
    workflowExecutionFixture({
      executionId: 102,
      frameId: 1,
      graphKey: 'release',
      nodeId: 'triage',
      displayName: 'Ask about the risky rename',
      status: scenario === 'interrupted' ? 'running' : triageWaiting ? 'awaiting' : 'completed',
      startedAt: at(4),
      endedAt: scenario === 'interrupted' ? null : triageWaiting ? null : at(14),
      // A restart took the process that would have recorded this callback's end with it.
      endCertainty: scenario === 'interrupted' ? 'unknown' : 'observed',
      callbackStartedAt: at(4),
      callbackEndedAt: scenario === 'interrupted' ? null : at(5.4),
      waitArmedAt: at(5.4),
      waitDeliveredAt: triageWaiting ? null : at(14),
      attemptCount: 1,
      firstArtifactHash: PIN_ONE,
      latestArtifactHash: PIN_ONE,
      latestAttempt: attempt(1, PIN_ONE, triageWaiting ? 'running' : 'succeeded'),
      wait:
        scenario === 'interrupted'
          ? null
          : {
              waitId: 5,
              kind: scenario === 'waiting_continue' ? 'user_continue' : 'user_input',
              status: triageWaiting ? 'armed' : 'delivered',
              label: 'The writer needs direction.',
              questions:
                scenario === 'waiting_continue'
                  ? null
                  : [
                      { kind: 'text', key: 'verdict', label: 'What should change?' },
                      {
                        kind: 'select',
                        key: 'severity',
                        label: 'How risky is it?',
                        options: [
                          { value: 'low', label: 'Low' },
                          { value: 'high', label: 'High' },
                        ],
                      },
                    ],
              answers: triageWaiting
                ? null
                : { verdict: 'Rename the loader export', severity: 'high' },
              armedAt: at(5.4),
              deliveredAt: triageWaiting ? null : at(14),
            },
      routing: triageWaiting
        ? null
        : {
            edgeId: 'after-triage',
            attemptIndex: 1,
            chosen: 'first-pass',
            updateRef: { inline: { verdict: 'revise' } },
            startedAt: at(14),
            endedAt: at(14.1),
            failure: null,
          },
      operationSummary: {
        count: triageOperations,
        unresolved: scenario === 'blocked_operation' ? 1 : 0,
        capabilities: ['send_agent_prompt', 'run_headless_agent'],
      },
      stateInRef: { inline: { draft: 'Bump the runtime to 0.0.4', verdict: null } },
      candidateRef: { inline: { verdict: 'revise' } },
      updateRef: { inline: { verdict: 'revise' } },
      stateOutRef: { inline: { draft: 'Bump the runtime to 0.0.4', verdict: 'revise' } },
    }),
  );

  for (let index = 0; index < triageOperations; index += 1) {
    const uncertain = scenario === 'blocked_operation' && index === triageOperations - 1;
    operations.push(
      workflowOperationFixture({
        operationKey: `op-triage-${index}`,
        frameId: 1,
        executionId: 102,
        attemptId: 1,
        callIndex: index,
        capability: index % 2 === 0 ? 'send_agent_prompt' : 'run_headless_agent',
        state: uncertain ? 'uncertain' : 'completed',
        stage: index % 2 === 0 ? null : uncertain ? 'starting' : 'started',
        requestRef:
          index === 2
            ? { payloadRef: 'p:gone', byteSize: 1_024, mediaType: 'text/plain' }
            : { payloadRef: 'p:prompt', byteSize: 2_180, mediaType: 'text/plain' },
        requestHash: `sha256:req${index}fixture`,
        receiptRef: uncertain ? null : { inline: { turnId: `t-${88 + index}`, accepted: true } },
        // A produced JSON `null` on one call, so "the step produced nothing" and "the step produced
        // null" are both on screen and distinguishable.
        resultRef: uncertain ? null : index === 1 ? { inline: null } : { inline: { findings: 2 } },
        target: {
          agentSessionId: 7,
          paneId: 1211,
          ptyProcessId: index % 2 === 0 ? null : 29,
          turnId: `t-${88 + index}`,
        },
        uncertaintyDetail: uncertain
          ? 'The process that would have captured the result is gone.'
          : null,
        stop:
          scenario === 'cancelled' && index === 0
            ? {
                state: 'unsupported',
                detail: 'This capability cannot be stopped from here.',
                requestedAt: at(160),
                settledAt: at(160),
              }
            : { state: 'not_requested', detail: null, requestedAt: null, settledAt: null },
        lateEvidenceRef:
          scenario === 'cancelled' && index === 1 ? { inline: { turnId: 't-late' } } : null,
        createdAt: at(4.2 + index * 0.1),
        dispatchedAt: at(4.3 + index * 0.1),
        settledAt: uncertain ? null : at(5.2 + index * 0.1),
      }),
    );
  }

  // 3 · first-pass → the reusable `review` graph, with a third level inside it.
  addReviewPass({
    frames,
    executions,
    operations,
    nodeId: 'first-pass',
    subgraphExecutionId: 103,
    frameId: 2,
    rulesFrameId: 3,
    startSeconds: 15,
    pin,
    failing: scenario === 'callback_failed' || scenario === 'routing_failed',
    failureKind: scenario === 'routing_failed' ? 'routing' : 'callback',
    repaired,
    running: scenario === 'running' || scenario === 'waiting_agent',
  });

  // 4 · second-pass — the same definition, an entirely separate history.
  if (scenario === 'done' || scenario === 'authored_failure' || scenario === 'cancelled') {
    addReviewPass({
      frames,
      executions,
      operations,
      nodeId: 'second-pass',
      subgraphExecutionId: 120,
      frameId: 4,
      rulesFrameId: 5,
      startSeconds: 60,
      pin,
      failing: false,
      failureKind: 'callback',
      repaired: false,
      running: false,
    });
  }

  if (options.longHistory) {
    // Enough revisits to force more than one page and to make windowing matter.
    for (let index = 0; index < 60; index += 1) {
      executions.push(
        workflowExecutionFixture({
          executionId: 400 + index,
          frameId: 2,
          graphKey: 'review',
          parentExecutionId: 103,
          depth: 1,
          nodeId: 'read',
          visitIndex: 2 + index,
          status: 'completed',
          startedAt: at(200 + index * 2),
          endedAt: at(201 + index * 2),
          callbackStartedAt: at(200 + index * 2),
          callbackEndedAt: at(201 + index * 2),
          firstArtifactHash: pin,
          latestArtifactHash: pin,
          latestAttempt: attempt(1, pin, 'succeeded'),
          operationSummary: { count: 0, unresolved: 0, capabilities: [] },
        }),
      );
    }
  }

  return {
    summary: summaryFor(scenario, pin, options.longHistory),
    descriptor: descriptorFor(pin),
    artifactHash: pin,
    executions,
    frames,
    operations,
    events: eventsFor(scenario),
    payloads: storedPayloads,
  };
}

function attempt(index: number, pin: string, status: 'succeeded' | 'failed' | 'running') {
  return {
    attemptId: index,
    attemptIndex: index,
    artifactHash: pin,
    status,
    invocationKind: 'initial' as const,
    failure: null,
    recoveryMode: 'rerun_producer' as const,
    producerArtifactHash: null,
  };
}

/**
 * One invocation of the reusable `review` graph, with its own nested `rules` frame.
 *
 * Called twice with different registrations so the page can show that one definition reused is two
 * histories, at three levels of depth.
 */
function addReviewPass(input: {
  frames: WorkflowFrameDto[];
  executions: WorkflowExecutionDto[];
  operations: WorkflowOperationDto[];
  nodeId: string;
  subgraphExecutionId: number;
  frameId: number;
  rulesFrameId: number;
  startSeconds: number;
  pin: string;
  failing: boolean;
  failureKind: 'callback' | 'routing';
  repaired: boolean;
  running: boolean;
}) {
  const {
    frames,
    executions,
    operations,
    nodeId,
    subgraphExecutionId,
    frameId,
    rulesFrameId,
    startSeconds: start,
    pin,
    failing,
    failureKind,
    repaired,
    running,
  } = input;

  const reviewFrame = workflowFrameFixture({
    frameId,
    parentExecutionId: subgraphExecutionId,
    parentFrameId: 1,
    graphKey: 'review',
    entryArtifactHash: pin,
    depth: 1,
    // A frame is initializing, active or completed. A segment inside it is what failed, so a
    // failing pass is an active frame whose node execution carries the failure.
    status: failing || running ? 'active' : 'completed',
    displayName: `${nodeId} · review`,
    enteredAt: at(start),
    completedAt: failing || running ? null : at(start + 30),
    parametersRef: { inline: { draft: 'Bump the runtime to 0.0.4' } },
    stateRef: { inline: { draft: 'Bump the runtime to 0.0.4', findings: [] } },
    executionCount: 3,
    ...(failing || running
      ? {}
      : {
          output: {
            outcomeId: 'accepted',
            outcomeKind: 'success' as const,
            outcomeReason: null,
            producedRef: { inline: { findings: [] } },
            producerArtifactHash: pin,
          },
        }),
  });
  frames.push(reviewFrame);

  executions.push(
    workflowExecutionFixture({
      executionId: subgraphExecutionId,
      frameId: 1,
      graphKey: 'release',
      nodeId,
      nodeKind: 'subgraph',
      childFrameId: frameId,
      childFrame: reviewFrame,
      displayName: null,
      status: failing ? 'failed' : running ? 'running' : 'completed',
      startedAt: at(start),
      endedAt: failing || running ? null : at(start + 30),
      callbackStartedAt: null,
      callbackEndedAt: null,
      attemptCount: 0,
      firstArtifactHash: pin,
      latestArtifactHash: pin,
      latestAttempt: null,
      operationSummary: { count: 0, unresolved: 0, capabilities: [] },
      stateInRef: { inline: { draft: 'Bump the runtime to 0.0.4' } },
    }),
  );

  // Two visits to `read`, so pips and revisits are both real.
  for (const visitIndex of [0, 1]) {
    const isSecond = visitIndex === 1;
    const failedHere = failing && failureKind === 'callback' && isSecond;
    executions.push(
      workflowExecutionFixture({
        executionId: subgraphExecutionId + 1 + visitIndex,
        frameId,
        graphKey: 'review',
        parentExecutionId: subgraphExecutionId,
        depth: 1,
        nodeId: 'read',
        visitIndex,
        displayName: isSecond ? 'second read' : 'first read',
        // A capture that failed is a diagnostic about a name, never a failed step.
        labelDiagnostic: isSecond ? null : 'label callback threw: TypeError',
        status: failedHere ? 'failed' : 'completed',
        startedAt: at(start + 1 + visitIndex * 10),
        endedAt: at(start + 5 + visitIndex * 10),
        callbackStartedAt: at(start + 1 + visitIndex * 10),
        callbackEndedAt: at(start + 5 + visitIndex * 10),
        attemptCount: repaired && isSecond ? 2 : 1,
        firstArtifactHash: repaired && isSecond ? PIN_ONE : pin,
        latestArtifactHash: pin,
        latestAttempt: failedHere
          ? {
              ...attempt(1, pin, 'failed'),
              failure: {
                code: 'node_callback_failed',
                message: 'TypeError: cannot read property findings of undefined',
                detail: null,
              },
            }
          : {
              ...attempt(repaired && isSecond ? 2 : 1, pin, 'succeeded'),
              ...(repaired && isSecond
                ? {
                    invocationKind: 'retry' as const,
                    recoveryMode: 'reuse_producer_output' as const,
                    producerArtifactHash: PIN_ONE,
                  }
                : {}),
            },
        priorFailures:
          repaired && isSecond
            ? [
                {
                  attemptId: 1,
                  attemptIndex: 1,
                  segmentKind: 'node_callback' as const,
                  artifactHash: PIN_ONE,
                  failure: {
                    code: 'reduction_failed' as const,
                    message: 'findings rejected an update it did not declare',
                    detail: null,
                  },
                  repairedByAttemptIndex: 2,
                  repairedByArtifactHash: PIN_TWO,
                },
              ]
            : [],
        routing:
          failing && failureKind === 'routing' && isSecond
            ? {
                edgeId: 'after-read',
                attemptIndex: 1,
                chosen: null,
                updateRef: null,
                startedAt: at(start + 5 + visitIndex * 10),
                endedAt: at(start + 5.2 + visitIndex * 10),
                failure: {
                  code: 'edge_choose_failed',
                  message: 'RangeError: findings[0] is undefined',
                  detail: null,
                },
              }
            : failedHere
              ? null
              : {
                  edgeId: 'after-read',
                  attemptIndex: 1,
                  chosen: 'deep-check',
                  updateRef: { inline: { findings: [] } },
                  startedAt: at(start + 5 + visitIndex * 10),
                  endedAt: at(start + 5.1 + visitIndex * 10),
                  failure: null,
                },
        operationSummary: {
          count: 1,
          unresolved: 0,
          capabilities: ['send_agent_prompt'],
        },
        stateInRef: { inline: { draft: 'Bump the runtime to 0.0.4', findings: [] } },
        candidateRef: isSecond ? { inline: null } : { inline: { findings: ['unbounded query'] } },
        // The second visit committed nothing, which is not the same as producing JSON null.
        updateRef: isSecond ? null : { inline: { findings: ['unbounded query'] } },
        stateOutRef: isSecond
          ? { payloadRef: 'p:tampered', byteSize: 900, mediaType: 'application/json' }
          : { inline: { draft: 'Bump the runtime to 0.0.4', findings: ['unbounded query'] } },
      }),
    );
    operations.push(
      workflowOperationFixture({
        operationKey: `op-read-${subgraphExecutionId}-${visitIndex}`,
        frameId,
        executionId: subgraphExecutionId + 1 + visitIndex,
        attemptId: 1,
        callIndex: 0,
        capability: 'send_agent_prompt',
        state: 'completed',
        requestRef: { payloadRef: 'p:prompt', byteSize: 2_180, mediaType: 'text/plain' },
        requestHash: 'sha256:readfixture',
        receiptRef: { inline: { turnId: 't-91' } },
        resultRef: { inline: { findings: [] } },
        target: { agentSessionId: 7, paneId: null, ptyProcessId: null, turnId: 't-91' },
        createdAt: at(start + 1.2 + visitIndex * 10),
        dispatchedAt: at(start + 1.3 + visitIndex * 10),
        settledAt: at(start + 4.8 + visitIndex * 10),
      }),
    );
  }

  // Third level: a `rules` frame inside the review pass.
  const rulesFrame = workflowFrameFixture({
    frameId: rulesFrameId,
    parentExecutionId: subgraphExecutionId + 3,
    parentFrameId: frameId,
    graphKey: 'rules',
    entryArtifactHash: pin,
    depth: 2,
    status: 'completed',
    enteredAt: at(start + 6),
    completedAt: at(start + 9),
    parametersRef: { inline: { findings: [] } },
    executionCount: 1,
    output: {
      outcomeId: 'clean',
      outcomeKind: 'success',
      outcomeReason: null,
      producedRef: { inline: { findings: [] } },
      producerArtifactHash: pin,
    },
  });
  frames.push(rulesFrame);

  executions.push(
    workflowExecutionFixture({
      executionId: subgraphExecutionId + 3,
      frameId,
      graphKey: 'review',
      parentExecutionId: subgraphExecutionId,
      depth: 1,
      nodeId: 'deep-check',
      nodeKind: 'subgraph',
      childFrameId: rulesFrameId,
      childFrame: rulesFrame,
      status: 'completed',
      startedAt: at(start + 6),
      endedAt: at(start + 9),
      callbackStartedAt: null,
      callbackEndedAt: null,
      attemptCount: 0,
      firstArtifactHash: pin,
      latestArtifactHash: pin,
      latestAttempt: null,
      operationSummary: { count: 0, unresolved: 0, capabilities: [] },
    }),
    workflowExecutionFixture({
      executionId: subgraphExecutionId + 4,
      frameId: rulesFrameId,
      graphKey: 'rules',
      parentExecutionId: subgraphExecutionId + 3,
      depth: 2,
      nodeId: 'scan',
      status: 'completed',
      startedAt: at(start + 6.2),
      endedAt: at(start + 8.8),
      callbackStartedAt: at(start + 6.2),
      callbackEndedAt: at(start + 8.8),
      firstArtifactHash: pin,
      latestArtifactHash: pin,
      latestAttempt: attempt(1, pin, 'succeeded'),
      operationSummary: { count: 1, unresolved: 0, capabilities: ['run_headless_agent'] },
      stateInRef: { inline: { findings: [] } },
      stateOutRef: { inline: { findings: [] } },
      routing: {
        edgeId: 'after-scan',
        attemptIndex: 1,
        chosen: 'lint-pass',
        updateRef: null,
        startedAt: at(start + 8.8),
        endedAt: at(start + 8.9),
        failure: null,
      },
    }),
  );

  // Fourth level: a `lint` frame inside the rule checks. Nesting this deep is what proves that
  // addressing, expansion and keyboard reach do not quietly stop working a level or two down.
  const lintFrame = workflowFrameFixture({
    frameId: rulesFrameId + 100,
    parentExecutionId: subgraphExecutionId + 5,
    parentFrameId: rulesFrameId,
    graphKey: 'lint',
    entryArtifactHash: pin,
    depth: 3,
    status: 'completed',
    enteredAt: at(start + 9.1),
    completedAt: at(start + 10.6),
    parametersRef: { inline: { findings: [] } },
    executionCount: 1,
    output: {
      outcomeId: 'linted',
      outcomeKind: 'success',
      outcomeReason: null,
      producedRef: { inline: { findings: [] } },
      producerArtifactHash: pin,
    },
  });
  frames.push(lintFrame);

  executions.push(
    workflowExecutionFixture({
      executionId: subgraphExecutionId + 5,
      frameId: rulesFrameId,
      graphKey: 'rules',
      // The subgraph visit that opened the frame this execution lives in — `deep-check`, not the
      // sibling that routed to it.
      parentExecutionId: subgraphExecutionId + 3,
      depth: 2,
      nodeId: 'lint-pass',
      nodeKind: 'subgraph',
      childFrameId: lintFrame.frameId,
      childFrame: lintFrame,
      status: 'completed',
      startedAt: at(start + 9.1),
      endedAt: at(start + 10.6),
      callbackStartedAt: null,
      callbackEndedAt: null,
      attemptCount: 0,
      firstArtifactHash: pin,
      latestArtifactHash: pin,
      latestAttempt: null,
      operationSummary: { count: 0, unresolved: 0, capabilities: [] },
    }),
    workflowExecutionFixture({
      executionId: subgraphExecutionId + 6,
      frameId: lintFrame.frameId,
      graphKey: 'lint',
      parentExecutionId: subgraphExecutionId + 5,
      depth: 3,
      nodeId: 'rules-run',
      status: 'completed',
      startedAt: at(start + 9.3),
      endedAt: at(start + 10.4),
      callbackStartedAt: at(start + 9.3),
      callbackEndedAt: at(start + 10.4),
      firstArtifactHash: pin,
      latestArtifactHash: pin,
      latestAttempt: attempt(1, pin, 'succeeded'),
      operationSummary: { count: 0, unresolved: 0, capabilities: [] },
      stateInRef: { inline: { findings: [] } },
      stateOutRef: { inline: { findings: [] } },
      routing: {
        edgeId: 'after-rules-run',
        attemptIndex: 1,
        chosen: 'linted',
        updateRef: null,
        startedAt: at(start + 10.4),
        endedAt: at(start + 10.5),
        failure: null,
      },
    }),
  );
  operations.push(
    workflowOperationFixture({
      operationKey: `op-scan-${rulesFrameId}`,
      frameId: rulesFrameId,
      executionId: subgraphExecutionId + 4,
      attemptId: 1,
      callIndex: 0,
      capability: 'run_headless_agent',
      state: 'completed',
      stage: 'started',
      requestRef: { inline: { rules: 5 } },
      requestHash: 'sha256:scanfixture',
      receiptRef: { inline: { exitCode: 0 } },
      resultRef: { inline: { findings: [] } },
      target: { agentSessionId: null, paneId: null, ptyProcessId: 29, turnId: null },
      createdAt: at(start + 6.3),
      dispatchedAt: at(start + 6.4),
      settledAt: at(start + 8.7),
    }),
  );
}

function summaryFor(scenario: ScenarioKey, pin: string, longHistory: boolean): WorkflowRunSummary {
  const common = {
    runId: RUN_ID,
    workflowKey: 'isagi/release-check',
    title: 'release-check',
    rootGraphKey: 'release',
    artifactHash: pin,
    pinOrdinal: pin === PIN_TWO ? 2 : 1,
    attachment: { worktreeId: 12, surfaceId: 121 },
    origin: placement(true),
    destination: placement(scenario !== 'blocked_environment'),
    createdAt: at(0),
    updatedAt: at(180),
    revision: longHistory ? 400 : 60,
  } as const;

  const controls = {
    pause: true,
    resume: false,
    retry: false,
    cancel: true,
    dismiss: false,
    advance: false,
  };

  switch (scenario) {
    case 'ready':
      return workflowSummaryFixture({
        ...common,
        status: 'ready',
        position: { kind: 'node_callback', frameId: 1, executionId: 102 },
        activeNode: {
          frameId: 1,
          graphKey: 'release',
          nodeId: 'triage',
          nodeKind: 'operation',
          executionId: 102,
          visitIndex: 0,
          displayName: null,
        },
        controls,
      });
    case 'running':
      return workflowSummaryFixture({
        ...common,
        status: 'running',
        position: { kind: 'node_callback', frameId: 2, executionId: 104 },
        activeNode: activeRead(104),
        controls,
      });
    case 'waiting_agent':
      return workflowSummaryFixture({
        ...common,
        status: 'waiting',
        position: { kind: 'node_callback', frameId: 2, executionId: 104 },
        activeNode: activeRead(104),
        controls,
      });
    case 'waiting_questions':
    case 'waiting_continue':
      return workflowSummaryFixture({
        ...common,
        status: 'waiting',
        position: { kind: 'awaiting_wait', frameId: 1, executionId: 102, waitId: 5 },
        activeNode: activeTriage(),
        blockingWait: {
          waitId: 5,
          kind: scenario === 'waiting_continue' ? 'user_continue' : 'user_input',
          label: 'The writer needs direction.',
          frameId: 1,
          executionId: 102,
          questions:
            scenario === 'waiting_continue'
              ? null
              : [{ kind: 'text', key: 'verdict', label: 'What should change?' }],
          armedAt: at(5.4),
        },
        controls: { ...controls, advance: true },
      });
    case 'paused':
      return workflowSummaryFixture({
        ...common,
        status: 'waiting',
        paused: true,
        position: { kind: 'awaiting_wait', frameId: 1, executionId: 102, waitId: 5 },
        activeNode: activeTriage(),
        controls: { ...controls, pause: false, resume: true },
      });
    case 'blocked_operation':
      return workflowSummaryFixture({
        ...common,
        status: 'blocked',
        position: { kind: 'node_callback', frameId: 1, executionId: 102 },
        activeNode: activeTriage(),
        blockedOperation: { operationKey: 'op-triage-1', frameId: 1, executionId: 102 },
        controls: { ...controls, retry: true },
      });
    case 'blocked_environment':
      return workflowSummaryFixture({
        ...common,
        status: 'blocked',
        position: { kind: 'node_callback', frameId: 1, executionId: 102 },
        activeNode: activeTriage(),
        controls: { ...controls, retry: true },
      });
    case 'callback_failed':
      return workflowSummaryFixture({
        ...common,
        status: 'failed',
        position: { kind: 'node_callback', frameId: 2, executionId: 105 },
        activeNode: activeRead(105),
        failure: {
          code: 'node_callback_failed',
          message: 'TypeError: cannot read property findings of undefined',
          segmentKind: 'node_callback',
          attemptId: 1,
          frameId: 2,
          executionId: 105,
        },
        controls: { ...controls, pause: false, cancel: false, retry: true, dismiss: true },
      });
    case 'routing_failed':
      return workflowSummaryFixture({
        ...common,
        status: 'failed',
        position: { kind: 'routing', frameId: 2, executionId: 105, edgeId: 'after-read' },
        activeNode: activeRead(105),
        failure: {
          code: 'edge_choose_failed',
          message: 'RangeError: findings[0] is undefined',
          segmentKind: 'routing',
          attemptId: 1,
          frameId: 2,
          executionId: 105,
        },
        controls: { ...controls, pause: false, cancel: false, retry: true, dismiss: true },
      });
    case 'done':
      return workflowSummaryFixture({
        ...common,
        status: 'done',
        endedAt: at(180),
        position: { kind: 'terminal' },
        outcome: {
          outcomeId: 'shipped',
          kind: 'success',
          reason: 'Every check passed.',
          producedRef: { inline: { verdict: 'ship' } },
        },
        controls: { ...controls, pause: false, cancel: false, dismiss: true },
      });
    case 'authored_failure':
      return workflowSummaryFixture({
        ...common,
        status: 'done',
        endedAt: at(180),
        position: { kind: 'terminal' },
        // A declared failure outcome finished on purpose. It has nothing to repair, which is the
        // difference between this and a segment that threw.
        outcome: {
          outcomeId: 'rejected',
          kind: 'failure',
          reason: 'Two rules failed on the second pass.',
          producedRef: { inline: { verdict: 'reject' } },
        },
        controls: { ...controls, pause: false, cancel: false, dismiss: true },
      });
    case 'interrupted':
      return workflowSummaryFixture({
        ...common,
        // A parked root presents as paused with a reason; restart-specific vocabulary is deferred.
        status: 'running',
        paused: true,
        position: { kind: 'node_callback', frameId: 1, executionId: 102 },
        activeNode: activeTriage(),
        controls: { ...controls, pause: false, resume: true },
      });
    case 'root_init_failed':
      return workflowSummaryFixture({
        ...common,
        status: 'failed',
        position: { kind: 'graph_entry', frameId: 1 },
        failure: {
          code: 'graph_init_failed',
          message: "TypeError: cannot read property 'head' of undefined",
          segmentKind: 'graph_entry',
          attemptId: 1,
          frameId: 1,
          executionId: null,
        },
        controls: { ...controls, pause: false, cancel: false, retry: true, dismiss: true },
      });
    case 'cancelled':
      return workflowSummaryFixture({
        ...common,
        status: 'cancelled',
        endedAt: at(170),
        position: { kind: 'terminal' },
        stopSummary: { requested: 3, confirmed: 1, failed: 0, unsupported: 1, pending: 1 },
        controls: { ...controls, pause: false, cancel: false, dismiss: true },
      });
  }
}

const activeTriage = () => ({
  frameId: 1,
  graphKey: 'release',
  nodeId: 'triage',
  nodeKind: 'operation' as const,
  executionId: 102,
  visitIndex: 0,
  displayName: 'Ask about the risky rename',
});

const activeRead = (executionId: number) => ({
  frameId: 2,
  graphKey: 'review',
  nodeId: 'read',
  nodeKind: 'operation' as const,
  executionId,
  visitIndex: executionId === 105 ? 1 : 0,
  displayName: 'second read',
});

/**
 * History, as the complete deltas a reconnecting client would replay.
 *
 * Pause boundaries and pin adoption live only here — no entity row carries them — so a page that
 * skipped this read would draw a run that was never paused.
 */
function eventsFor(scenario: ScenarioKey): readonly WorkflowRunTransitionDelta[] {
  const transition = (
    revision: number,
    kind: WorkflowRunTransitionDelta['transition']['kind'],
    recordedAt: string,
  ): WorkflowRunTransitionDelta => ({
    runId: RUN_ID,
    revision,
    transition: {
      revision,
      recordedAt,
      kind,
      frameId: 1,
      executionId: null,
      attemptId: null,
      operationKey: null,
      waitId: null,
      artifactHash: kind === 'retry_pin_adopted' ? PIN_TWO : null,
      detailRef: null,
      stateRef: null,
    },
    changes: { executions: [], frames: [], operations: [] },
  });

  if (scenario === 'paused') return [transition(40, 'pause_opened', at(20))];
  if (scenario === 'done' || scenario === 'authored_failure') {
    return [transition(40, 'pause_opened', at(20)), transition(41, 'pause_closed', at(45))];
  }
  return [];
}
