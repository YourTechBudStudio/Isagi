import type {
  GetWorkflowRunOutput,
  WorkflowEventDto,
  WorkflowEventKind,
  WorkflowExecutionDetailDto,
  WorkflowExecutionSummaryDto,
  WorkflowGraphInvocationDto,
  WorkflowOperationDto,
  WorkflowRunSummary,
  WorkflowStructureDescriptorDto,
  WorkflowWaitDto,
} from '@isagi/contracts';

import {
  workflowEventFixture,
  workflowExecutionFixture,
  workflowInvocationFixture,
  workflowOperationFixture,
  workflowSummaryFixture,
} from '../../../src/lib/workspace/workflow/test-support.js';
import {
  CHECKPOINT_PIN,
  CHECKPOINT_ROOT_GRAPH,
  checkpointDescriptor,
  checkpointExecutions,
  checkpointInvocations,
} from './checkpoints.js';

/**
 * One run, as the runtime would actually describe it.
 *
 * Every record here is a real DTO built from the shared fixtures, so the page exercises the
 * production data layer end to end rather than a plausible-looking stand-in. Ids, hashes and names
 * are invented but structurally honest: the run detail, each execution's detail and the event log
 * all describe the same history, and the events are what the runtime would have appended as it
 * happened.
 */

/** The build the run launched on. The `done` run's Retry moved it onto `PIN_ONE`. */
export const PIN_ZERO = 'sha256:0c3e5d1fixturezero';
export const PIN_ONE = 'sha256:9f2c1abfixtureone';
export const PIN_TWO = 'sha256:4d81e07fixturetwo';

export type ScenarioKey =
  | 'running'
  | 'waiting_agent'
  | 'waiting_questions'
  | 'waiting_continue'
  | 'paused'
  | 'callback_failed'
  | 'done'
  | 'authored_failure'
  | 'cancelled'
  | 'root_init_failed'
  | 'interrupted'
  | 'checkpoints';

export const scenarioKeys: readonly ScenarioKey[] = [
  'running',
  'waiting_agent',
  'waiting_questions',
  'waiting_continue',
  'paused',
  'callback_failed',
  'done',
  'authored_failure',
  'cancelled',
  'root_init_failed',
  // Cut off by an app restart while its node function ran.
  'interrupted',
  // A different, smaller graph: a loop that saves checkpoints. See `checkpoints.ts`.
  'checkpoints',
];

export interface FixtureWorld {
  readonly runId: number;
  readonly summary: WorkflowRunSummary;
  readonly detail: GetWorkflowRunOutput;
  readonly executionDetails: ReadonlyMap<number, WorkflowExecutionDetailDto>;
  readonly events: readonly WorkflowEventDto[];
}

// Anchored to when the page loaded, so a live scenario reads as a run that started a few minutes
// ago rather than one that has apparently been going since the fixture was written.
const base = Date.now() - 180_000;
export const at = (seconds: number): string => new Date(base + seconds * 1000).toISOString();

/* ── structure ─────────────────────────────────────────────────────────────────────────────── */

/**
 * The reviewed-document shape: collect, ask a person, then two independent review passes over one
 * reusable `review` graph, whose own `deep-check` step nests two more levels.
 *
 * `review` being registered twice is the point. Two registrations of one definition must keep two
 * separate histories, and only a deeply nested fixture can show that a node four levels down is
 * still reachable and correctly addressed.
 */
export function descriptorFor(artifactHash: string): WorkflowStructureDescriptorDto {
  if (artifactHash === CHECKPOINT_PIN) return checkpointDescriptor;
  const withSignOff = artifactHash === PIN_TWO;
  return {
    descriptorVersion: 2,
    workflowContractVersion: 5,
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
          // Added by the build a later Retry reloads. Before that it does not exist at all; after
          // it, it is a node that has never run.
          ...(withSignOff ? [{ id: 'sign-off', kind: 'operation' as const }] : []),
        ],
        edges: [
          { id: 'after-collect', from: 'collect', to: ['triage'] },
          { id: 'after-triage', from: 'triage', to: ['first-pass', 'rejected'] },
          { id: 'after-first', from: 'first-pass', to: ['second-pass', 'shipped'] },
          {
            id: 'after-second',
            from: 'second-pass',
            // The later build changes where this edge can go without changing its id, which is the
            // shape a layout identity derived from element keys alone could not tell apart.
            to: withSignOff ? ['sign-off', 'rejected'] : ['shipped', 'rejected'],
          },
          ...(withSignOff
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
          { id: 'after-read', from: 'read', to: ['deep-check', 'accepted'] },
          { id: 'after-deep-check', from: 'deep-check', to: ['read'] },
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

/* ── the run ───────────────────────────────────────────────────────────────────────────────── */

export const TRIAGE_PROMPT =
  'Review the diff below and report anything that would break a clean checkout.\n\nFocus on:\n- unbounded queries\n- secrets in logs\n- unchecked JSON parsing\n';
export const TRIAGE_REPLY = 'Two risky renames: the loader export and the CLI flag.';
export const READ_REPLY = 'The first pass found one unbounded query.';

export interface BuildOptions {
  readonly runId: number;
  readonly scenario: ScenarioKey;
  /** The build the run is on now. `PIN_TWO` after the fixture's Retry adopts it. */
  readonly pin: string;
  /** A long run, for the virtualization the waterfall has to survive. */
  readonly longHistory: boolean;
  /** Whether the agent turn `read` waits on has ended and its reply was recorded. */
  readonly replyArrived: boolean;
  /** Events appended after the world was built, such as a live code reload. */
  readonly extraEvents: readonly Omit<WorkflowEventDto, 'eventId' | 'runId'>[];
}

/** One execution as the builder collects it: its summary, its detail and what happened when. */
interface Step {
  readonly summary: WorkflowExecutionSummaryDto;
  readonly result: unknown;
  readonly event: unknown;
  readonly decision: unknown;
  readonly stateAfter: unknown;
  readonly operations: readonly WorkflowOperationDto[];
  readonly waitingAt: string | null;
  readonly deliveredAt: string | null;
}

class RunBuilder {
  readonly invocations: WorkflowGraphInvocationDto[] = [];
  readonly steps: Step[] = [];
  readonly events: Omit<WorkflowEventDto, 'eventId' | 'runId'>[] = [];

  constructor(readonly runId: number) {}

  invocation(overrides: Partial<WorkflowGraphInvocationDto>) {
    const row = workflowInvocationFixture(overrides);
    this.invocations.push(row);
    this.event(
      row.startedAt,
      row.parentExecutionId,
      'node',
      'graph_entered',
      `Entered ${row.graphKey}`,
      {
        invocationId: row.invocationId,
        graphKey: row.graphKey,
      },
    );
    if (row.outcome !== null && row.endedAt !== null) {
      this.event(
        row.endedAt,
        row.parentExecutionId,
        'node',
        'graph_completed',
        `${row.graphKey} finished`,
        {
          outcomeId: row.outcome.outcomeId,
        },
      );
    }
    return row;
  }

  step(input: {
    readonly summary: Partial<WorkflowExecutionSummaryDto> & {
      readonly executionId: number;
      readonly invocationId: number;
      readonly nodeId: string;
      readonly startedAt: string;
    };
    readonly result?: unknown;
    readonly event?: unknown;
    readonly decision?: unknown;
    readonly stateAfter?: unknown;
    readonly operations?: readonly WorkflowOperationDto[];
    readonly waitingAt?: string | null;
    readonly deliveredAt?: string | null;
  }) {
    const summary = workflowExecutionFixture({ runId: this.runId, ...input.summary });
    const step: Step = {
      summary,
      result: input.result ?? { type: 'complete', update: {} },
      event: input.event ?? null,
      decision:
        input.decision ?? (summary.routedTo === null ? null : { to: summary.routedTo, update: {} }),
      stateAfter:
        input.stateAfter ??
        (summary.routedTo === null ? null : { draft: 'Bump the runtime to 0.0.4' }),
      operations: input.operations ?? [],
      waitingAt: input.waitingAt ?? null,
      deliveredAt: input.deliveredAt ?? null,
    };
    this.steps.push(step);

    const id = summary.executionId;
    const name = summary.label ?? summary.nodeId;
    this.event(summary.startedAt, id, 'node', 'node_started', `Started ${name}`, {
      nodeId: summary.nodeId,
      nodeKind: summary.nodeKind,
      ...(summary.retryOf === null ? {} : { retryOf: summary.retryOf }),
    });
    for (const operation of step.operations) {
      this.event(operation.startedAt, id, 'node', 'operation_started', operation.kind, {
        operationId: operation.operationId,
        kind: operation.kind,
      });
      if (operation.endedAt !== null) {
        this.event(operation.endedAt, id, 'node', 'operation_finished', operation.kind, {
          operationId: operation.operationId,
          kind: operation.kind,
          status: operation.status,
        });
      }
    }
    if (step.waitingAt !== null) {
      this.event(step.waitingAt, id, 'node', 'node_waiting', `${name} is waiting`, summary.wait);
    }
    if (step.deliveredAt !== null) {
      this.event(
        step.deliveredAt,
        id,
        'node',
        'wait_delivered',
        `${summary.nodeId}: answered`,
        step.event,
      );
    }
    if (summary.endedAt !== null) {
      const kind: WorkflowEventKind =
        summary.status === 'failed'
          ? 'node_failed'
          : summary.status === 'interrupted'
            ? 'node_interrupted'
            : 'node_completed';
      this.event(summary.endedAt, id, 'node', kind, `${name} ${summary.status}`, {
        to: summary.routedTo,
      });
    }
    return summary;
  }

  event(
    when: string,
    executionId: number | null,
    category: WorkflowEventDto['category'],
    kind: WorkflowEventKind,
    message: string,
    data: unknown = null,
  ) {
    this.events.push({ executionId, at: when, category, kind, message, data });
  }
}

function sendPrompt(
  executionId: number,
  seq: number,
  input: {
    readonly startedAt: string;
    readonly prompt: string;
    readonly responseText: string | null;
  },
): WorkflowOperationDto {
  return workflowOperationFixture({
    operationId: executionId * 10 + seq,
    executionId,
    seq,
    kind: 'send_prompt',
    agentSessionId: 7,
    paneId: 1211,
    harness: 'claude',
    model: 'opus',
    effort: 'high',
    request: { prompt: input.prompt, harness: 'claude', model: 'opus', effort: 'high' },
    status: 'completed',
    responseText: input.responseText,
    result: { agentSessionId: 7, paneId: 1211, sentAt: input.startedAt },
    harnessSessionId: 'd02f91ee-fixture',
    usage: {
      inputTokens: 1200,
      cacheReadInputTokens: 3000,
      cacheCreationInputTokens: null,
      outputTokens: 420,
      costUsd: 0.0213,
    },
    startedAt: input.startedAt,
    endedAt: input.startedAt,
  });
}

function runHeadless(
  executionId: number,
  seq: number,
  input: { readonly startedAt: string; readonly endedAt: string; readonly prompt: string },
): WorkflowOperationDto {
  return workflowOperationFixture({
    operationId: executionId * 10 + seq,
    executionId,
    seq,
    kind: 'run_headless',
    agentSessionId: null,
    paneId: null,
    harness: 'codex',
    model: null,
    effort: null,
    request: { prompt: input.prompt, harness: 'codex', timeoutMs: 600_000 },
    status: 'completed',
    responseText: 'loader.ts: export renamed\ncli.ts: flag renamed',
    result: { exitCode: 0 },
    startedAt: input.startedAt,
    endedAt: input.endedAt,
  });
}

export function buildWorld(options: BuildOptions): FixtureWorld {
  const { scenario, pin, runId } = options;

  if (scenario === 'checkpoints') {
    const builder = new RunBuilder(runId);
    for (const row of checkpointInvocations()) builder.invocation(row);
    for (const step of checkpointExecutions()) builder.step(step);
    const summary = workflowSummaryFixture({
      runId,
      title: 'implement-story',
      workflowKey: 'isagi/implement-story',
      artifactHash: CHECKPOINT_PIN,
      surfaceId: 121,
      worktreeId: 12,
      worktreePath: '/work/isagi/.worktrees/release',
      status: 'failed',
      createdAt: at(0),
      updatedAt: at(71),
      error: {
        stage: 'checkpoint_capture',
        message: 'scope "reviews" passes through a symlink',
        graphKey: CHECKPOINT_ROOT_GRAPH,
        nodeId: 'savePhase',
      },
      controls: { pause: false, resume: false, retry: true, cancel: false, dismiss: true },
    });
    return finish(builder, summary, options);
  }

  const builder = new RunBuilder(runId);
  const finished = scenario === 'done' || scenario === 'authored_failure';
  const ended = finished || scenario === 'cancelled';
  const retried = ended;
  // Before the Retry, every execution ran on the launch build; the Retry and everything after it
  // on the build it reloaded.
  const launchBuild = retried ? PIN_ZERO : pin;

  builder.event(at(0), null, 'run', 'run_launched', 'Launched release-check');
  builder.event(at(0.2), null, 'environment', 'worktree_created', 'Created worktree release', {
    worktreeId: 12,
  });

  const root = builder.invocation({
    invocationId: 1,
    graphKey: 'release',
    depth: 0,
    label: 'release check',
    status: finished ? 'completed' : scenario === 'cancelled' ? 'cancelled' : 'running',
    parameters: null,
    state: { draft: 'Bump the runtime to 0.0.4', verdict: finished ? 'ship' : null },
    outcome: finished
      ? {
          outcomeId: scenario === 'done' ? 'shipped' : 'rejected',
          kind: scenario === 'done' ? 'success' : 'failure',
          reason:
            scenario === 'done' ? 'Every check passed.' : 'Two rules failed on the second pass.',
          output: { verdict: scenario === 'done' ? 'ship' : 'reject' },
        }
      : null,
    startedAt: at(0.5),
    endedAt: ended ? at(62) : null,
  });

  const summaryOverrides: { -readonly [K in keyof WorkflowRunSummary]?: WorkflowRunSummary[K] } =
    {};

  if (scenario === 'root_init_failed') {
    summaryOverrides.status = 'failed';
    summaryOverrides.error = {
      stage: 'graph_init',
      message: "TypeError: cannot read property 'head' of undefined",
      graphKey: 'release',
    };
    summaryOverrides.controls = {
      pause: false,
      resume: false,
      retry: true,
      cancel: false,
      dismiss: true,
    };
    builder.event(at(0.6), null, 'run', 'run_failed', "release's init threw", {
      stage: 'graph_init',
    });
    return finish(builder, summaryFor(runId, pin, root, summaryOverrides), options);
  }

  // 1 · collect
  builder.step({
    summary: {
      executionId: 101,
      invocationId: 1,
      nodeId: 'collect',
      label: '34 files across 6 packages',
      artifactHash: launchBuild,
      status: 'completed',
      routedTo: 'triage',
      startedAt: at(1),
      endedAt: at(3.4),
    },
    result: { type: 'complete', update: { draft: 'Bump the runtime to 0.0.4' } },
    // No wait, so nothing came back: JSON `null`, a value in its own right.
    event: null,
    decision: { to: 'triage', update: {} },
    stateAfter: { draft: 'Bump the runtime to 0.0.4', verdict: null, notes: [] },
  });

  // 2 · triage — a user wait *and* real side effects, which must coexist.
  const triageWaiting =
    scenario === 'waiting_questions' || scenario === 'waiting_continue' || scenario === 'paused';
  const triageInterrupted = scenario === 'interrupted';
  const triageWait: WorkflowWaitDto =
    scenario === 'waiting_continue'
      ? { kind: 'user_continue', label: 'Fix the flag name in the pane, then Continue.' }
      : {
          kind: 'user_input',
          questions: [
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
        };
  const triageAnswer = {
    kind: 'user_input',
    answers: { verdict: 'Rename the loader export', severity: 'high' },
  };
  builder.step({
    summary: {
      executionId: 102,
      invocationId: 1,
      nodeId: 'triage',
      label: 'Ask about the risky rename',
      artifactHash: launchBuild,
      status: triageInterrupted ? 'interrupted' : triageWaiting ? 'waiting' : 'completed',
      wait: triageInterrupted ? null : triageWait,
      routedTo: triageWaiting || triageInterrupted ? null : 'first-pass',
      error: triageInterrupted
        ? {
            stage: 'node_function',
            message: 'Interrupted by an app restart.',
            graphKey: 'release',
            nodeId: 'triage',
          }
        : null,
      startedAt: at(4),
      endedAt: triageWaiting ? null : triageInterrupted ? at(6) : at(14),
    },
    result: triageInterrupted ? null : { type: 'suspend', update: {}, wait: triageWait },
    event: triageWaiting || triageInterrupted ? null : triageAnswer,
    decision:
      triageWaiting || triageInterrupted
        ? null
        : { to: 'first-pass', update: { verdict: 'revise' } },
    stateAfter:
      triageWaiting || triageInterrupted
        ? null
        : { draft: 'Bump the runtime to 0.0.4', verdict: 'revise', notes: [] },
    operations: [
      sendPrompt(102, 0, { startedAt: at(4.2), prompt: TRIAGE_PROMPT, responseText: TRIAGE_REPLY }),
      runHeadless(102, 1, {
        startedAt: at(4.4),
        endedAt: at(5.2),
        prompt: 'List every exported symbol that changed.',
      }),
    ],
    waitingAt: triageInterrupted ? null : at(5.4),
    deliveredAt: triageWaiting || triageInterrupted ? null : at(14),
  });

  if (scenario === 'paused') {
    builder.event(at(20), null, 'run', 'run_paused', 'Paused', { reason: 'control' });
  }

  if (triageInterrupted) {
    builder.event(at(6), null, 'run', 'run_failed', 'Interrupted by an app restart');
    summaryOverrides.status = 'failed';
    summaryOverrides.error = {
      stage: 'node_function',
      message: 'Interrupted by an app restart.',
      graphKey: 'release',
      nodeId: 'triage',
    };
    summaryOverrides.controls = {
      pause: false,
      resume: false,
      retry: true,
      cancel: false,
      dismiss: true,
    };
  }

  const reachedReview = !triageWaiting && !triageInterrupted;
  if (reachedReview) {
    addReviewPass(builder, {
      nodeId: 'first-pass',
      subgraphExecutionId: 103,
      invocationId: 2,
      rulesInvocationId: 3,
      start: 15,
      launchBuild,
      pin,
      scenario,
      replyArrived: options.replyArrived,
      retried,
    });
  }

  if (ended) {
    // A pause, recorded only as the two events that bound it.
    builder.event(at(35), null, 'run', 'run_paused', 'Paused', { reason: 'control' });
    builder.event(at(40), null, 'run', 'run_resumed', 'Resumed');
    addReviewPass(builder, {
      nodeId: 'second-pass',
      subgraphExecutionId: 120,
      invocationId: 4,
      rulesInvocationId: 5,
      start: 45,
      launchBuild: pin,
      pin,
      scenario: 'done',
      replyArrived: true,
      retried: false,
      routedTo:
        scenario === 'done' ? 'shipped' : scenario === 'authored_failure' ? 'rejected' : null,
    });
    builder.event(
      at(62),
      null,
      'run',
      finished ? 'run_completed' : 'run_cancelled',
      finished ? 'Finished' : 'Cancelled',
    );
  }

  builder.event(at(4.5), 102, 'log', 'log', 'Asked the agent about the diff', {
    level: 'info',
    message: 'Asked the agent about the diff',
  });
  builder.event(at(4.6), 102, 'ui', 'ui_feedback', 'Triage', { kind: 'info', phase: 'Triage' });

  if (options.longHistory) {
    // Enough revisits to make windowing matter.
    for (let index = 0; index < 60; index += 1) {
      builder.step({
        summary: {
          executionId: 400 + index,
          invocationId: 1,
          nodeId: 'collect',
          visitIndex: 1 + index,
          artifactHash: pin,
          status: 'completed',
          routedTo: 'triage',
          startedAt: at(200 + index * 2),
          endedAt: at(201 + index * 2),
        },
      });
    }
  }

  switch (scenario) {
    case 'running':
      summaryOverrides.status = 'running';
      summaryOverrides.current = current(104, 2, 'review', 'read', null);
      break;
    case 'waiting_agent':
      summaryOverrides.status = 'waiting';
      summaryOverrides.current = current(104, 2, 'review', 'read', {
        kind: 'agent_turn',
        target: { agentSessionId: 7, sentAt: at(16.2) },
      });
      break;
    case 'waiting_questions':
    case 'waiting_continue':
      summaryOverrides.status = 'waiting';
      summaryOverrides.current = current(102, 1, 'release', 'triage', triageWait);
      break;
    case 'paused':
      summaryOverrides.status = 'paused';
      summaryOverrides.current = current(102, 1, 'release', 'triage', triageWait);
      summaryOverrides.controls = {
        pause: false,
        resume: true,
        retry: false,
        cancel: true,
        dismiss: false,
      };
      break;
    case 'callback_failed':
      summaryOverrides.status = 'failed';
      summaryOverrides.current = current(105, 2, 'review', 'read', null);
      summaryOverrides.error = {
        stage: 'node_function',
        message: 'TypeError: cannot read property findings of undefined',
        graphKey: 'review',
        nodeId: 'read',
      };
      summaryOverrides.controls = {
        pause: false,
        resume: false,
        retry: true,
        cancel: false,
        dismiss: true,
      };
      break;
    case 'done':
    case 'authored_failure':
      summaryOverrides.status = 'completed';
      summaryOverrides.endedAt = at(62);
      summaryOverrides.outcome = root.outcome;
      summaryOverrides.controls = {
        pause: false,
        resume: false,
        retry: false,
        cancel: false,
        dismiss: true,
      };
      break;
    case 'cancelled':
      summaryOverrides.status = 'cancelled';
      summaryOverrides.endedAt = at(62);
      summaryOverrides.controls = {
        pause: false,
        resume: false,
        retry: false,
        cancel: false,
        dismiss: true,
      };
      break;
    default:
      break;
  }

  return finish(builder, summaryFor(runId, pin, root, summaryOverrides), options);
}

function current(
  executionId: number,
  invocationId: number,
  graphKey: string,
  nodeId: string,
  wait: WorkflowWaitDto | null,
): NonNullable<WorkflowRunSummary['current']> {
  return { executionId, invocationId, graphKey, nodeId, nodeKind: 'operation', label: null, wait };
}

function summaryFor(
  runId: number,
  pin: string,
  root: WorkflowGraphInvocationDto,
  overrides: Partial<WorkflowRunSummary>,
): WorkflowRunSummary {
  return workflowSummaryFixture({
    runId,
    workflowKey: 'isagi/release-check',
    title: 'release-check',
    artifactHash: pin,
    status: 'waiting',
    origin: {
      worktreeId: 12,
      worktreePath: '/work/isagi/.worktrees/release',
      surfaceId: 121,
      paneId: 1211,
      agentSessionId: 7,
    },
    worktreeId: 12,
    worktreePath: '/work/isagi/.worktrees/release',
    surfaceId: 121,
    createdAt: at(0),
    updatedAt: root.endedAt ?? at(180),
    ...overrides,
  });
}

function finish(
  builder: RunBuilder,
  summary: WorkflowRunSummary,
  options: BuildOptions,
): FixtureWorld {
  const ordered = [...builder.events, ...options.extraEvents].sort((left, right) =>
    left.at < right.at ? -1 : left.at > right.at ? 1 : 0,
  );
  // Extra events always come last: they were appended after everything the build describes.
  const extras = new Set(options.extraEvents);
  const events = [...ordered.filter((event) => !extras.has(event)), ...options.extraEvents].map(
    (event, index) => workflowEventFixture({ ...event, eventId: index + 1, runId: builder.runId }),
  );
  const executionDetails = new Map<number, WorkflowExecutionDetailDto>();
  for (const step of builder.steps) {
    executionDetails.set(step.summary.executionId, {
      ...step.summary,
      result: step.result,
      event: step.event,
      decision: step.decision,
      stateAfter: step.stateAfter,
      operations: step.operations,
    });
  }
  return {
    runId: builder.runId,
    summary,
    detail: {
      run: summary,
      inputs: { story: 'release 0.1.0' },
      parameters: { story: 'release 0.1.0' },
      invocations: [...builder.invocations].sort(
        (left, right) => left.invocationId - right.invocationId,
      ),
      executions: builder.steps
        .map((step) => step.summary)
        .sort((left, right) => left.executionId - right.executionId),
    },
    executionDetails,
    events,
  };
}

/**
 * One invocation of the reusable `review` graph, with `rules` and `lint` nested inside it.
 *
 * Called twice with different registrations so the page can show that one definition reused is two
 * histories, four levels deep. On the first pass the second `read` fails and, when the run was
 * retried, a Retry execution repeats it under the reloaded build.
 */
function addReviewPass(
  builder: RunBuilder,
  input: {
    readonly nodeId: string;
    readonly subgraphExecutionId: number;
    readonly invocationId: number;
    readonly rulesInvocationId: number;
    readonly start: number;
    readonly launchBuild: string;
    readonly pin: string;
    readonly scenario: ScenarioKey;
    readonly replyArrived: boolean;
    readonly retried: boolean;
    readonly routedTo?: string | null;
  },
) {
  const { subgraphExecutionId: sub, start, launchBuild, pin, scenario } = input;
  const isFirst = input.nodeId === 'first-pass';
  const live = isFirst && (scenario === 'running' || scenario === 'waiting_agent');
  const failing = isFirst && scenario === 'callback_failed';
  const secondFails = isFirst && (failing || input.retried);
  const completed = !live && !failing;
  const endAt = at(start + 18);

  builder.invocation({
    invocationId: input.invocationId,
    parentExecutionId: sub,
    graphKey: 'review',
    depth: 1,
    label: `${input.nodeId} · review`,
    status: completed ? 'completed' : 'running',
    parameters: { draft: 'Bump the runtime to 0.0.4' },
    state: { draft: 'Bump the runtime to 0.0.4', findings: ['unbounded query'] },
    outcome: completed
      ? { outcomeId: 'accepted', kind: 'success', reason: null, output: { findings: [] } }
      : null,
    startedAt: at(start),
    endedAt: completed ? endAt : null,
  });

  builder.step({
    summary: {
      executionId: sub,
      invocationId: 1,
      nodeId: input.nodeId,
      nodeKind: 'subgraph',
      artifactHash: launchBuild,
      // A cancelled run's last subgraph never routed: Cancel stopped it.
      status: completed ? (input.routedTo === null ? 'cancelled' : 'completed') : 'waiting',
      childInvocationId: input.invocationId,
      routedTo: completed ? (input.routedTo === undefined ? 'second-pass' : input.routedTo) : null,
      startedAt: at(start),
      endedAt: completed ? endAt : null,
    },
    result: { type: 'suspend', update: {}, wait: null },
  });

  // `read`, first visit: an agent turn.
  const readLive = live;
  builder.step({
    summary: {
      executionId: sub + 1,
      invocationId: input.invocationId,
      nodeId: 'read',
      visitIndex: 0,
      label: 'first read',
      artifactHash: launchBuild,
      status: readLive ? (scenario === 'waiting_agent' ? 'waiting' : 'running') : 'completed',
      wait:
        scenario === 'waiting_agent' || !readLive
          ? { kind: 'agent_turn', target: { agentSessionId: 7, sentAt: at(start + 1.2) } }
          : null,
      routedTo: readLive ? null : 'deep-check',
      startedAt: at(start + 1),
      endedAt: readLive ? null : at(start + 5),
    },
    result:
      readLive && scenario === 'running'
        ? null
        : {
            type: 'suspend',
            update: {},
            wait: { kind: 'agent_turn', target: { agentSessionId: 7, sentAt: at(start + 1.2) } },
          },
    event: readLive ? null : { kind: 'ended', agentSessionId: 7 },
    decision: readLive ? null : { to: 'deep-check', update: { findings: ['unbounded query'] } },
    stateAfter: readLive
      ? null
      : { draft: 'Bump the runtime to 0.0.4', findings: ['unbounded query'] },
    operations: [
      sendPrompt(sub + 1, 0, {
        startedAt: at(start + 1.2),
        prompt: 'Read the diff and list what could break.',
        responseText: readLive && !input.replyArrived ? null : READ_REPLY,
      }),
    ],
    waitingAt: readLive && scenario === 'running' ? null : at(start + 1.3),
    deliveredAt: readLive ? null : at(start + 5),
  });

  if (live) return;

  // `deep-check`, which enters `rules`, which enters `lint`.
  const rulesId = input.rulesInvocationId;
  const lintId = rulesId + 100;
  builder.step({
    summary: {
      executionId: sub + 3,
      invocationId: input.invocationId,
      nodeId: 'deep-check',
      nodeKind: 'subgraph',
      artifactHash: launchBuild,
      status: 'completed',
      childInvocationId: rulesId,
      routedTo: 'read',
      startedAt: at(start + 6),
      endedAt: at(start + 9.8),
    },
  });
  builder.invocation({
    invocationId: rulesId,
    parentExecutionId: sub + 3,
    graphKey: 'rules',
    depth: 2,
    status: 'completed',
    parameters: { findings: [] },
    state: { findings: [] },
    outcome: { outcomeId: 'clean', kind: 'success', reason: null, output: { findings: [] } },
    startedAt: at(start + 6),
    endedAt: at(start + 9.7),
  });
  builder.step({
    summary: {
      executionId: sub + 4,
      invocationId: rulesId,
      nodeId: 'scan',
      artifactHash: launchBuild,
      status: 'completed',
      routedTo: 'lint-pass',
      startedAt: at(start + 6.2),
      endedAt: at(start + 8.8),
    },
    operations: [
      runHeadless(sub + 4, 0, {
        startedAt: at(start + 6.3),
        endedAt: at(start + 8.7),
        prompt: 'Scan the diff against the five release rules.',
      }),
    ],
    result: { type: 'suspend', update: {}, wait: { kind: 'headless_agent', operations: [] } },
    waitingAt: at(start + 6.4),
    deliveredAt: at(start + 8.7),
  });
  builder.step({
    summary: {
      executionId: sub + 5,
      invocationId: rulesId,
      nodeId: 'lint-pass',
      nodeKind: 'subgraph',
      artifactHash: launchBuild,
      status: 'completed',
      childInvocationId: lintId,
      routedTo: 'clean',
      startedAt: at(start + 9.1),
      endedAt: at(start + 9.6),
    },
  });
  builder.invocation({
    invocationId: lintId,
    parentExecutionId: sub + 5,
    graphKey: 'lint',
    depth: 3,
    status: 'completed',
    parameters: { findings: [] },
    state: { findings: [] },
    outcome: { outcomeId: 'linted', kind: 'success', reason: null, output: { findings: [] } },
    startedAt: at(start + 9.1),
    endedAt: at(start + 9.55),
  });
  builder.step({
    summary: {
      executionId: sub + 6,
      invocationId: lintId,
      nodeId: 'rules-run',
      artifactHash: launchBuild,
      status: 'completed',
      routedTo: 'linted',
      startedAt: at(start + 9.2),
      endedAt: at(start + 9.5),
    },
  });

  // `read`, second visit: fails on the first pass, and is retried when the run was.
  builder.step({
    summary: {
      executionId: sub + 2,
      invocationId: input.invocationId,
      nodeId: 'read',
      visitIndex: 1,
      label: 'second read',
      artifactHash: launchBuild,
      status: secondFails ? 'failed' : 'completed',
      routedTo: secondFails ? null : 'accepted',
      error: secondFails
        ? {
            stage: 'node_function',
            message: 'TypeError: cannot read property findings of undefined',
            graphKey: 'review',
            nodeId: 'read',
          }
        : null,
      startedAt: at(start + 10),
      endedAt: at(start + 11),
    },
    result: secondFails ? null : { type: 'complete', update: { findings: [] } },
    decision: secondFails ? null : { to: 'accepted', update: {} },
    stateAfter: secondFails ? null : { draft: 'Bump the runtime to 0.0.4', findings: [] },
  });

  if (secondFails && input.retried) {
    builder.event(at(start + 12), null, 'run', 'run_failed', 'read threw', {
      stage: 'node_function',
    });
    builder.event(at(start + 13), null, 'run', 'code_reloaded', 'Reloaded the latest build', {
      from: PIN_ZERO,
      to: pin,
    });
    builder.event(at(start + 13), sub + 7, 'run', 'run_retried', 'Retrying second read', {
      retryOf: sub + 2,
      reusesResult: false,
    });
    builder.step({
      summary: {
        executionId: sub + 7,
        invocationId: input.invocationId,
        nodeId: 'read',
        visitIndex: 1,
        label: 'second read',
        artifactHash: pin,
        status: 'completed',
        retryOf: sub + 2,
        routedTo: 'accepted',
        startedAt: at(start + 13.1),
        endedAt: at(start + 16),
      },
      result: { type: 'complete', update: { findings: [] } },
      decision: { to: 'accepted', update: {} },
      stateAfter: { draft: 'Bump the runtime to 0.0.4', findings: [] },
    });
  }
}
