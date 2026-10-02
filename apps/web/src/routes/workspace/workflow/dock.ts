import type {
  WorkflowExecutionDetailDto,
  WorkflowExecutionSummaryDto,
  WorkflowGraphInvocationDto,
  WorkflowQuestionSpecDto,
  WorkflowWaitDto,
} from '@isagi/contracts';

import { workflowCopy, workflowErrorStageHeadline } from '../../../copy/index.js';
import { waitTimings } from '../../../lib/workspace/workflow/history.js';
import type { WorkflowRunView } from '../../../lib/workspace/workflow/run-view.js';
import { executionAncestry } from './ancestry.js';
import { inspectorCopy } from './copy.js';
import { visitsOf, type InspectorSelection } from './selection.js';
import { executionTiming, formatClock, formatDuration, intervalDuration } from './timing.js';
import { ancestorKeys, type DeclaredElement, type DeclaredTopology } from './topology.js';

/**
 * The dock's columns, as data.
 *
 * Deriving them here rather than inside JSX is what makes the rules testable: that a node the
 * current build no longer declares says so instead of borrowing another node's declaration, that a
 * Retry names the execution it retries, and that a node with a user wait keeps its operations.
 */

export type FieldTone = 'default' | 'dim' | 'warn' | 'bad' | 'ok';

/** The one place a tone becomes a colour. */
export function toneClass(tone: FieldTone | undefined): string {
  switch (tone) {
    case 'dim':
      return 'text-fg-subtle';
    case 'warn':
      return 'text-amber';
    case 'bad':
      return 'text-error';
    case 'ok':
      return 'text-green';
    default:
      return 'text-fg';
  }
}

export interface DockField {
  readonly label: string;
  readonly value: string;
  readonly tone?: FieldTone | undefined;
  /** Jumps the Data column to this tab, for a value that is recorded JSON. */
  readonly dataTab?: string | undefined;
  /** Moves the dock to another selection, for a value that names a different execution. */
  readonly selection?: InspectorSelection | undefined;
}

export type DockRow = DockField | { readonly gap: true };

export const gap: DockRow = { gap: true };

/** A captured label as a field, with a dim dash when there is none, wherever the dock shows one. */
export function labelRow(label: string | null): DockField {
  return label === null
    ? { label: 'label', value: '—', tone: 'dim' }
    : { label: 'label', value: label };
}

/**
 * A tab in the Data column: a recorded JSON value, or a checkpoint's files.
 *
 * `value` is `undefined` while the execution's detail is still being read, which the viewer shows as
 * a dash rather than as JSON `null` — a value the node produced.
 */
export type DockDataTab =
  | { readonly kind: 'value'; readonly key: string; readonly name: string; readonly value: unknown }
  | {
      readonly kind: 'checkpoint_files';
      readonly key: string;
      readonly name: string;
      readonly checkpointId: number;
    };

/** The `files` tab's key, which the Checkpoint column's count opens. */
export const checkpointFilesTabKey = 'checkpoint.files';

/** What a checkpoint execution shows in place of Operations, which it never has. */
export interface DockCheckpoint {
  readonly state: 'saved' | 'capturing' | 'nothing_saved';
  readonly checkpointId: number | null;
}

/** One execution inside a subgraph's child invocation, reachable from the dock. */
export interface DockChildExecution {
  readonly executionId: number;
  readonly nodeId: string;
  readonly label: string | null;
  readonly status: WorkflowExecutionSummaryDto['status'];
  readonly isSubgraph: boolean;
  readonly selection: InspectorSelection;
}

/**
 * What a subgraph has instead of operations of its own. `entered` is false before it has opened
 * its graph, which is a different thing from a graph that ran and did nothing.
 */
export interface DockNested {
  readonly entered: boolean;
  /** The child invocation's *direct* executions. Deeper ones are reached by selecting a nested one. */
  readonly children: readonly DockChildExecution[];
}

export type DockOperationsMode =
  | { readonly kind: 'operations' }
  /** A wait *and* its operations. A user wait never replaces what the node actually did. */
  | { readonly kind: 'wait_and_operations'; readonly waitFields: readonly DockRow[] }
  | { readonly kind: 'none'; readonly reason: string };

export interface DockView {
  /** Registration names from the root inwards, the last being the selection itself. */
  readonly breadcrumb: readonly { readonly label: string }[];
  readonly kindChip: string;
  readonly statusChip: string;
  readonly statusTone: FieldTone;
  readonly displayName: string | null;
  readonly declared: readonly DockRow[];
  readonly recorded: readonly DockRow[];
  readonly operations: DockOperationsMode;
  readonly data: readonly DockDataTab[];
  /** The execution whose detail and operations the dock shows, if any. */
  readonly executionId: number | null;
  /** For a subgraph execution: its child invocation's executions. */
  readonly nested: DockNested | null;
  /** Set only for an execution of a checkpoint node. */
  readonly checkpoint: DockCheckpoint | null;
}

export function buildDockView(input: {
  readonly selection: InspectorSelection | null;
  readonly view: WorkflowRunView;
  readonly topology: DeclaredTopology | null;
  /** The selected execution's detail, once read. */
  readonly detail: WorkflowExecutionDetailDto | null;
  readonly now: number;
}): DockView | null {
  const { selection, view, topology, detail, now } = input;
  if (selection === null) return null;

  switch (selection.kind) {
    case 'element':
      return elementView(selection.key, view, topology, detail, now);
    case 'execution': {
      const execution = view.executions.get(selection.executionId);
      return execution ? executionView(execution, view, topology, detail, now) : null;
    }
    case 'invocation': {
      const invocation = view.invocations.get(selection.invocationId);
      return invocation ? invocationView(invocation, view, now) : null;
    }
  }
}

/* ── declared elements ─────────────────────────────────────────────────────────────────────── */

function elementView(
  key: string,
  view: WorkflowRunView,
  topology: DeclaredTopology | null,
  detail: WorkflowExecutionDetailDto | null,
  now: number,
): DockView {
  const element = topology?.elements.get(key);
  const latest = visitsOf(view, key).at(-1);
  if (latest && element?.kind !== 'edge') {
    return executionView(latest, view, topology, detail, now);
  }

  return {
    breadcrumb: breadcrumbFor(key, topology, null),
    kindChip: element ? elementKindLabel(element) : 'unknown',
    statusChip: inspectorCopy.notVisited,
    statusTone: 'dim',
    displayName: null,
    declared: element ? declaredFields(element, topology) : [absentFromBuild()],
    recorded: [{ label: 'status', value: inspectorCopy.notVisited, tone: 'dim' }],
    operations: { kind: 'none', reason: operationsRefusal(element) },
    data: [],
    executionId: null,
    nested: null,
    checkpoint: null,
  };
}

/**
 * What the current build declares about an element. Per-node update fields are deliberately absent:
 * they cannot be known without running author code. Actual updates are recorded in Data.
 */
function declaredFields(
  element: DeclaredElement,
  topology: DeclaredTopology | null,
): readonly DockRow[] {
  const rows: DockRow[] = [
    { label: 'kind', value: elementKindLabel(element) },
    { label: 'id', value: element.address.id },
    { label: 'graph', value: element.graphKey },
  ];

  if (element.kind === 'node') {
    const descriptor = element.descriptor;
    if (descriptor.title) rows.push({ label: 'title', value: descriptor.title });
    if (descriptor.kind === 'subgraph') {
      rows.push(gap, { label: 'invokes', value: descriptor.graphKey });
    }
    const routerKey = topology?.routerOf.get(element.key);
    const edge = routerKey === undefined ? undefined : topology?.elements.get(routerKey);
    if (edge?.kind === 'edge') {
      rows.push(gap, { label: 'edge', value: edge.descriptor.id });
      rows.push({ label: 'to', value: edge.descriptor.to.join(', ') });
    }
    return rows;
  }

  if (element.kind === 'edge') {
    rows.push({ label: 'from', value: element.descriptor.from });
    rows.push({ label: 'to', value: element.descriptor.to.join(', ') });
    if (element.descriptor.title) rows.push({ label: 'title', value: element.descriptor.title });
    return rows;
  }

  rows.push({ label: 'result', value: element.descriptor.kind });
  if (element.descriptor.reason) rows.push({ label: 'reason', value: element.descriptor.reason });
  if (element.descriptor.title) rows.push({ label: 'title', value: element.descriptor.title });
  return rows;
}

function absentFromBuild(): DockField {
  return { label: 'declared', value: inspectorCopy.absentFromCurrentBuild, tone: 'warn' };
}

/* ── executions ────────────────────────────────────────────────────────────────────────────── */

function executionView(
  execution: WorkflowExecutionSummaryDto,
  view: WorkflowRunView,
  topology: DeclaredTopology | null,
  detail: WorkflowExecutionDetailDto | null,
  now: number,
): DockView {
  const ancestry = executionAncestry(view, execution);
  const key = `${ancestry.path.join('/')}::node:${execution.nodeId}`;
  const element = topology?.elements.get(key);
  const visits = visitsOf(view, key);
  const timing = executionTiming(execution, waitTimings(view.events).get(execution.executionId));
  const isSubgraph = execution.nodeKind === 'subgraph';
  // Only trust detail that is about this execution: a refetch for the previous selection may land.
  const own = detail?.executionId === execution.executionId ? detail : null;

  const recorded: DockRow[] = [{ label: 'execution', value: String(execution.executionId) }];
  if (visits.length > 1) {
    const position = visits.findIndex((visit) => visit.executionId === execution.executionId);
    recorded.push({ label: 'visit', value: `${position + 1} of ${visits.length}` });
  }
  recorded.push(labelRow(execution.label));
  recorded.push({
    label: 'status',
    value: execution.status,
    tone: statusTone(execution.status),
  });
  if (execution.retryOf !== null) {
    recorded.push({
      label: 'retry of',
      value: `execution ${execution.retryOf}`,
      tone: 'warn',
      selection: { kind: 'execution', executionId: execution.retryOf },
    });
  }
  recorded.push(
    execution.artifactHash === view.run.artifactHash
      ? { label: 'build', value: shortHash(execution.artifactHash) }
      : {
          label: 'build',
          value: inspectorCopy.olderBuild(shortHash(execution.artifactHash)),
          tone: 'warn',
        },
  );
  recorded.push(gap);
  recorded.push({ label: 'started', value: formatClock(execution.startedAt) });
  recorded.push(
    execution.endedAt === null
      ? { label: 'ended', value: inspectorCopy.stillOpen, tone: 'warn' }
      : { label: 'ended', value: formatClock(execution.endedAt) },
  );
  recorded.push(durationRow('duration', timing.total, now));
  if (timing.wait !== null) {
    recorded.push(durationRow('run', timing.run, now));
    recorded.push(durationRow('wait', timing.wait, now));
  }

  if (execution.error !== null) {
    recorded.push(gap);
    recorded.push({
      label: execution.status === 'interrupted' ? 'interrupted' : 'failed',
      value: workflowErrorStageHeadline(execution.error.stage),
      tone: 'bad',
    });
    recorded.push({ label: 'stage', value: execution.error.stage, tone: 'bad' });
    const where = [execution.error.graphKey, execution.error.nodeId].filter(Boolean).join('/');
    if (where) recorded.push({ label: 'in', value: where, tone: 'bad' });
    recorded.push({ label: 'message', value: execution.error.message, tone: 'bad' });
    if (execution.status === 'failed' || execution.status === 'interrupted') {
      recorded.push({ label: 'repair', value: workflowCopy.retryPinNote, tone: 'warn' });
    }
  }

  if (execution.routedTo !== null) {
    recorded.push(gap);
    recorded.push({
      label: 'routed to',
      value: execution.routedTo,
      tone: 'ok',
      ...(own === null ? {} : { dataTab: 'decision' }),
    });
  }

  const child =
    execution.childInvocationId === null
      ? undefined
      : view.invocations.get(execution.childInvocationId);
  if (isSubgraph && child) {
    recorded.push(gap);
    recorded.push({
      label: 'invocation',
      value: `${child.graphKey} · ${child.invocationId}`,
      selection: { kind: 'invocation', invocationId: child.invocationId },
    });
    recorded.push(
      child.outcome
        ? {
            label: 'outcome',
            value: `${child.outcome.outcomeId} · ${child.outcome.kind}`,
            tone: child.outcome.kind === 'failure' ? 'bad' : 'ok',
            dataTab: 'output',
          }
        : { label: 'outcome', value: inspectorCopy.outputNotProduced, tone: 'warn' },
    );
  }

  const data: DockDataTab[] = [
    valueTab('result', own?.result),
    valueTab('event', own?.event),
    valueTab('decision', own?.decision),
    valueTab('state_after', own?.stateAfter),
  ];
  if (child) {
    data.push(valueTab('parameters', child.parameters));
    if (child.outcome) data.push(valueTab('output', child.outcome.output));
  }
  if (execution.checkpointId !== null) {
    data.push({
      kind: 'checkpoint_files',
      key: checkpointFilesTabKey,
      name: inspectorCopy.checkpointFilesTab,
      checkpointId: execution.checkpointId,
    });
  }

  return {
    breadcrumb: breadcrumbFor(key, topology, execution),
    kindChip: execution.nodeKind,
    statusChip: execution.status,
    statusTone: statusTone(execution.status),
    displayName: execution.label,
    declared: element ? declaredFields(element, topology) : [absentFromBuild()],
    recorded,
    operations: operationsMode(execution),
    data,
    executionId: execution.executionId,
    nested: isSubgraph
      ? {
          entered: child !== undefined,
          children: child === undefined ? [] : directChildren(view, child.invocationId),
        }
      : null,
    checkpoint:
      execution.nodeKind === 'checkpoint'
        ? {
            checkpointId: execution.checkpointId,
            state:
              execution.checkpointId !== null
                ? 'saved'
                : execution.status === 'running'
                  ? 'capturing'
                  : 'nothing_saved',
          }
        : null,
  };
}

function valueTab(name: string, value: unknown): DockDataTab {
  return { kind: 'value', key: name, name, value };
}

/** The child invocation's own executions, in the order they ran. Direct children only. */
function directChildren(
  view: WorkflowRunView,
  invocationId: number,
): readonly DockChildExecution[] {
  const children: DockChildExecution[] = [];
  for (const id of view.executionOrder) {
    const execution = view.executions.get(id);
    if (!execution || execution.invocationId !== invocationId) continue;
    children.push({
      executionId: execution.executionId,
      nodeId: execution.nodeId,
      label: execution.label,
      status: execution.status,
      isSubgraph: execution.nodeKind === 'subgraph',
      selection: { kind: 'execution', executionId: execution.executionId },
    });
  }
  return children;
}

/** A node with a wait keeps its operations too: it asked something *after* doing something. */
function operationsMode(execution: WorkflowExecutionSummaryDto): DockOperationsMode {
  if (execution.nodeKind === 'subgraph') {
    return { kind: 'none', reason: inspectorCopy.subgraphNoDirectOperations };
  }
  if (execution.nodeKind === 'checkpoint') {
    return { kind: 'none', reason: inspectorCopy.checkpointNoOperations };
  }
  if (execution.wait === null) return { kind: 'operations' };
  return { kind: 'wait_and_operations', waitFields: waitFields(execution.wait, execution) };
}

function waitFields(
  wait: WorkflowWaitDto,
  execution: WorkflowExecutionSummaryDto,
): readonly DockRow[] {
  const rows: DockRow[] = [{ label: 'kind', value: wait.kind }];
  switch (wait.kind) {
    case 'agent_turn':
      rows.push({ label: 'agent session', value: String(wait.target.agentSessionId) });
      rows.push({ label: 'sent', value: formatClock(wait.target.sentAt) });
      break;
    case 'user_continue':
      if (wait.label) rows.push({ label: 'label', value: wait.label });
      break;
    case 'user_input':
      for (const question of wait.questions) {
        rows.push({ label: question.key, value: questionSummary(question) });
      }
      break;
    case 'headless_agent':
      rows.push({
        label: 'operations',
        value: wait.operations.map((operation) => `#${operation.operationId}`).join(', '),
      });
      break;
  }
  if (execution.status === 'waiting') {
    rows.push(gap, {
      label: 'status',
      value:
        wait.kind === 'user_continue' || wait.kind === 'user_input'
          ? inspectorCopy.waitOnYou
          : inspectorCopy.waitOpen,
      tone: 'warn',
    });
    if (wait.kind === 'user_continue' || wait.kind === 'user_input') {
      rows.push({ label: 'answer in', value: inspectorCopy.answerInTheBar, tone: 'dim' });
    }
  } else {
    rows.push(gap, { label: 'delivered', value: inspectorCopy.waitDelivered, dataTab: 'event' });
  }
  return rows;
}

function questionSummary(question: WorkflowQuestionSpecDto): string {
  if (question.kind !== 'select' && question.kind !== 'multi-select') return question.kind;
  // The option's own label when it has one, and its value otherwise.
  const options = question.options.map((option) => option.label ?? option.value).join(', ');
  return options === '' ? question.kind : `${question.kind} · ${options}`;
}

/* ── graph invocations ─────────────────────────────────────────────────────────────────────── */

/** A graph invocation: the parameters it was entered with, its state now, and its outcome. */
function invocationView(
  invocation: WorkflowGraphInvocationDto,
  view: WorkflowRunView,
  now: number,
): DockView {
  const outcome = invocation.outcome;
  const started = Date.parse(invocation.startedAt);
  const ended = invocation.endedAt === null ? now : Date.parse(invocation.endedAt);
  const recorded: DockRow[] = [
    { label: 'invocation', value: String(invocation.invocationId) },
    { label: 'status', value: invocation.status, tone: statusTone(invocation.status) },
    { label: 'depth', value: String(invocation.depth) },
  ];
  if (invocation.parentExecutionId !== null) {
    recorded.push({
      label: 'entered by',
      value: `execution ${invocation.parentExecutionId}`,
      selection: { kind: 'execution', executionId: invocation.parentExecutionId },
    });
  }
  recorded.push(
    gap,
    { label: 'started', value: formatClock(invocation.startedAt) },
    invocation.endedAt === null
      ? { label: 'ended', value: inspectorCopy.stillOpen, tone: 'warn' }
      : { label: 'ended', value: formatClock(invocation.endedAt) },
    {
      label: 'duration',
      value: Number.isNaN(started) ? '—' : formatDuration(Math.max(0, ended - started)),
    },
  );
  if (outcome) {
    recorded.push(gap, {
      label: 'outcome',
      value: `${outcome.outcomeId} · ${outcome.kind}`,
      tone: outcome.kind === 'failure' ? 'bad' : 'ok',
      dataTab: 'output',
    });
    if (outcome.reason) recorded.push({ label: 'reason', value: outcome.reason });
  }
  const data: DockDataTab[] = [
    valueTab('parameters', invocation.parameters),
    valueTab('state', invocation.state),
  ];
  if (outcome) data.push(valueTab('output', outcome.output));

  return {
    breadcrumb: [{ label: invocation.graphKey }],
    kindChip: 'graph',
    statusChip: outcome?.kind ?? invocation.status,
    statusTone: outcome?.kind === 'failure' ? 'bad' : statusTone(invocation.status),
    displayName: invocation.label,
    declared: [
      { label: 'kind', value: 'graph' },
      { label: 'graph', value: invocation.graphKey },
    ],
    recorded,
    operations: { kind: 'none', reason: inspectorCopy.invocationNoOperations },
    data,
    executionId: null,
    nested: {
      entered: true,
      children: directChildren(view, invocation.invocationId),
    },
    checkpoint: null,
  };
}

/* ── shared rows ───────────────────────────────────────────────────────────────────────────── */

function durationRow(
  label: string,
  interval: ReturnType<typeof executionTiming>['total'],
  now: number,
): DockRow {
  const duration = intervalDuration(interval, now);
  if (interval === null || duration === null) return { label, value: '—', tone: 'dim' };
  return interval.end === null
    ? { label, value: `${formatDuration(duration)} · ${inspectorCopy.soFar}`, tone: 'warn' }
    : { label, value: formatDuration(duration) };
}

export function statusTone(status: string): FieldTone {
  switch (status) {
    case 'failed':
      return 'bad';
    case 'completed':
      return 'ok';
    case 'running':
    case 'waiting':
    case 'interrupted':
      return 'warn';
    default:
      return 'default';
  }
}

function operationsRefusal(element: DeclaredElement | undefined): string {
  if (element?.kind === 'edge') return inspectorCopy.edgesCannotCall;
  if (element?.kind === 'outcome') return inspectorCopy.outcomesCannotCall;
  if (element?.kind === 'node' && element.descriptor.kind === 'subgraph') {
    return inspectorCopy.subgraphNoDirectOperations;
  }
  return inspectorCopy.notVisitedNoOperations;
}

function elementKindLabel(element: DeclaredElement): string {
  return element.kind === 'node' ? element.descriptor.kind : element.kind;
}

function breadcrumbFor(
  key: string,
  topology: DeclaredTopology | null,
  execution: WorkflowExecutionSummaryDto | null,
): DockView['breadcrumb'] {
  const crumbs: { label: string }[] = [];
  if (topology) {
    for (const ancestor of ancestorKeys(topology, key)) {
      const element = topology.elements.get(ancestor);
      if (element) crumbs.push({ label: element.address.id });
    }
  }
  const self = topology?.elements.get(key);
  crumbs.push({ label: self?.address.id ?? execution?.nodeId ?? key });
  if (execution && execution.visitIndex > 0) {
    crumbs.push({ label: `visit ${execution.visitIndex + 1}` });
  }
  return crumbs;
}

/**
 * A build hash, short enough to sit in a dense row and still identify itself. The algorithm prefix
 * is dropped first: seven characters of `sha256:abc…` would be the part every hash shares.
 */
export function shortHash(hash: string): string {
  const separator = hash.indexOf(':');
  const digest = separator === -1 ? hash : hash.slice(separator + 1);
  return digest.slice(0, 7);
}
