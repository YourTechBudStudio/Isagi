import type {
  WorkflowEvidenceDto,
  WorkflowExecutionCheckpointDto,
  WorkflowExecutionDto,
  WorkflowFrameDto,
  WorkflowFrameSegmentDto,
  WorkflowOperationDto,
  WorkflowPayloadSlot,
  WorkflowQuestionSpecDto,
} from '@isagi/contracts';

import { workflowCopy, workflowFailureHeadline } from '../../../copy/index.js';
import type { WorkflowRunState } from '../../../lib/workspace/workflow/model.js';
import { executionAncestry } from './ancestry.js';
import {
  checkpointVisitRef,
  checkpointVisitState,
  type CheckpointVisitRef,
  type CheckpointVisitState,
} from './checkpoint-view.js';
import { inspectorCopy } from './copy.js';
import { visitsOf, type InspectorSelection } from './selection.js';
import { formatClock, formatDuration, executionTiming, intervalDuration } from './timing.js';
import { ancestorKeys, type DeclaredElement, type DeclaredTopology } from './topology.js';

/**
 * The five columns, as data.
 *
 * Deriving them here rather than inside JSX is what makes the honesty rules testable: that a
 * historical node absent from the current pin says so instead of borrowing another node's
 * declaration, that a payload a step never produced is distinguishable from one that cannot be read,
 * and that a node with a human wait keeps its operation cards instead of having them replaced.
 */

export type FieldTone = 'default' | 'dim' | 'warn' | 'bad' | 'ok';

/** The one place a tone becomes a colour, so a provenance row and a recorded row dim alike. */
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
  /** Jumps the Data column to this tab, for a value that is a recorded payload. */
  readonly dataTab?: string | undefined;
  /** Moves the dock to another selection, for a value that names a different visit. */
  readonly selection?: InspectorSelection | undefined;
}

export type DockRow = DockField | { readonly gap: true };

export const gap: DockRow = { gap: true };

interface DockDataTabBase {
  /**
   * Stable identity, so a tab survives anything that renames it.
   *
   * An operation's tab is named by its call position — `op1.request` — because that is what a
   * person sees on the card beside it, but it is *keyed* by the operation's own key: call positions
   * are per-execution ordinals, and keying a cache-bearing tab on an ordinal would tie it to a
   * position rather than to the operation that actually made the call.
   */
  readonly key: string;
  readonly name: string;
}

/**
 * A tab in the Data column, of which there are now two kinds.
 *
 * A **payload** tab shows a recorded slot, whose absence is itself a fact the viewer has to tell
 * apart from an unreadable one. An **evidence** tab shows bytes a capture kept: it has no slot and
 * cannot be absent — evidence exists only because a capture committed — but it does carry a media
 * type, because the same bytes are rendered differently depending on what they are *for*.
 *
 * Discriminated rather than merged with an optional slot: a shape where `slot: null` could mean
 * either "never produced" or "this is not that kind of tab" is exactly the conflation the payload
 * viewer exists to prevent.
 */
export type DockDataTab =
  | (DockDataTabBase & { readonly kind: 'payload'; readonly slot: WorkflowPayloadSlot })
  | (DockDataTabBase & {
      readonly kind: 'evidence';
      readonly evidenceKey: string;
      readonly mediaType: string;
      readonly byteSize: number;
    })
  | (DockDataTabBase & {
      /** A saved checkpoint's final file tree. It has no bytes of its own, so it has no size. */
      readonly kind: 'checkpoint_files';
      readonly checkpointId: string;
      readonly fileCount: number;
    });

/** The `files` tab's key, which the Checkpoint column's count opens. */
export const checkpointFilesTabKey = 'checkpoint.files';

/**
 * What a checkpoint visit shows in place of Operations and Evidence, which are always empty for it.
 *
 * `parent` resolves the saved checkpoint's parent to the visit that saved it. It is a function
 * rather than a value because the parent is only known once the detail has been read.
 */
export interface DockCheckpoint {
  readonly state: CheckpointVisitState;
  readonly summary: WorkflowExecutionCheckpointDto | null;
  readonly parent: (checkpointId: string) => CheckpointVisitRef | null;
}

/** One execution inside a subgraph's child frame, reachable from the dock. */
export interface DockChildExecution {
  readonly executionId: number;
  readonly nodeId: string;
  readonly displayName: string | null;
  readonly status: WorkflowExecutionDto['status'];
  readonly isSubgraph: boolean;
  readonly selection: InspectorSelection;
}

/**
 * What a subgraph registration has instead of operations of its own.
 *
 * `entered` is false when the visit has not opened a frame yet, which is a different thing from a
 * frame that ran and did nothing — an empty list under a completed heading would claim the second
 * while meaning the first.
 */
export interface DockNested {
  readonly entered: boolean;
  readonly executions: number;
  readonly operations: number;
  /** The child frame's *direct* executions. Deeper ones are reached by selecting a nested one. */
  readonly children: readonly DockChildExecution[];
}

/**
 * The payload tabs an execution's operations contribute.
 *
 * Kept out of `buildDockView` because operations are hydrated separately and arrive after it: the
 * view describes the selection, and this describes whatever operations have been read for it.
 *
 * A tab exists only where a payload slot was actually produced. A request always has one; a receipt,
 * a result and late evidence are each absent until the operation has one, and inventing an empty tab
 * for them would claim the operation produced something it did not.
 */
export function operationDataTabs(
  operations: readonly WorkflowOperationDto[],
): readonly DockDataTab[] {
  const tabs: DockDataTab[] = [];
  for (const operation of operations) {
    const ordinal = operation.callIndex + 1;
    tabs.push({
      kind: 'payload',
      key: operationTabKey(operation.operationKey, 'request'),
      name: `op${ordinal}.request`,
      slot: operation.requestRef,
    });
    for (const [slot, suffix] of [
      [operation.receiptRef, 'receipt'],
      [operation.resultRef, 'result'],
      [operation.lateEvidenceRef, 'lateEvidence'],
    ] as const) {
      if (slot === null) continue;
      tabs.push({
        kind: 'payload',
        key: operationTabKey(operation.operationKey, suffix),
        name: `op${ordinal}.${suffix}`,
        slot,
      });
    }
  }
  return tabs;
}

/**
 * The Data tabs a visit's captures contribute.
 *
 * Named by position in the Evidence column beside them — `ev1 · content` — because that is the
 * number a person just clicked, and keyed by the record's own immutable key for the reason an
 * operation tab is keyed by its operation: a position is an ordinal, and a cache-bearing tab keyed
 * on an ordinal follows the position rather than the thing.
 */
export function evidenceDataTabs(records: readonly WorkflowEvidenceDto[]): readonly DockDataTab[] {
  return records.map((record, index) => ({
    kind: 'evidence',
    key: evidenceTabKey(record.evidenceKey),
    name: `ev${index + 1} \u00b7 content`,
    evidenceKey: record.evidenceKey,
    mediaType: record.content.mediaType,
    byteSize: record.content.byteSize,
  }));
}

export function evidenceTabKey(evidenceKey: string): string {
  return `evidence::${evidenceKey}`;
}

export function operationTabKey(operationKey: string, slot: string): string {
  return `${operationKey}::${slot}`;
}

export type DockOperationsMode =
  | { readonly kind: 'operations' }
  /** A wait *and* its operations. A human wait never replaces what the node actually called. */
  | { readonly kind: 'wait_and_operations'; readonly waitFields: readonly DockRow[] }
  | { readonly kind: 'none'; readonly reason: string; readonly extra?: readonly DockRow[] };

export interface DockView {
  /** Registration names from the root inwards, the last being the selection itself. */
  readonly breadcrumb: readonly { readonly label: string; readonly displayName: string | null }[];
  readonly kindChip: string;
  readonly statusChip: string;
  readonly statusTone: FieldTone;
  readonly displayName: string | null;
  readonly declared: readonly DockRow[];
  readonly recorded: readonly DockRow[];
  readonly operations: DockOperationsMode;
  readonly data: readonly DockDataTab[];
  /** The execution whose operation cards belong in the Operations column, if any. */
  readonly executionId: number | null;
  /** Nested totals for a subgraph registration, which has no operations of its own. */
  readonly nested: DockNested | null;
  /** Set only for a visit to a checkpoint node. A declared, unvisited checkpoint keeps the defaults. */
  readonly checkpoint: DockCheckpoint | null;
}

export function buildDockView(input: {
  readonly selection: InspectorSelection | null;
  readonly state: WorkflowRunState;
  readonly topology: DeclaredTopology | null;
  readonly now: number;
}): DockView | null {
  const { selection, state, topology, now } = input;
  if (selection === null) return null;

  switch (selection.kind) {
    case 'element':
      return elementView(selection.key, state, topology, now);
    case 'execution': {
      const execution = state.executions.get(selection.executionId);
      return execution ? executionView(execution, state, topology, now) : null;
    }
    case 'routing': {
      const execution = state.executions.get(selection.executionId);
      return execution ? routingView(execution, state, topology, now) : null;
    }
    case 'frame_segment': {
      const frame = state.frames.get(selection.frameId);
      if (!frame) return null;
      const segment = selection.segment === 'entry' ? frame.entry : frame.outputEvaluation;
      return frameSegmentView(frame, selection.segment, segment, state, now);
    }
    case 'frame_output': {
      const frame = state.frames.get(selection.frameId);
      return frame ? frameOutputView(frame, state, now) : null;
    }
  }
}

/* ── declared elements ─────────────────────────────────────────────────────────────────────── */

function elementView(
  key: string,
  state: WorkflowRunState,
  topology: DeclaredTopology | null,
  now: number,
): DockView {
  const element = topology?.elements.get(key);
  const visits = visitsOf(state, key);
  const latest = visits.at(-1);

  if (latest && element?.kind !== 'edge') return executionView(latest, state, topology, now);

  const declared = element ? declaredFields(element, topology) : [absentFromPin()];
  return {
    breadcrumb: breadcrumbFor(key, topology, null),
    kindChip: element ? elementKindLabel(element) : 'unknown',
    statusChip: inspectorCopy.notVisited,
    statusTone: 'dim',
    displayName: null,
    declared,
    recorded: [{ label: 'status', value: inspectorCopy.notVisited, tone: 'dim' }],
    operations: { kind: 'none', reason: operationsRefusal(element) },
    data: [],
    executionId: null,
    nested: null,
    checkpoint: null,
  };
}

/**
 * What the current pin declares about an element.
 *
 * Deliberately absent: per-node and per-edge update-field lists. The callback API cannot reveal what
 * a node may update without executing or statically analysing author code, and a list produced that
 * way would be a guess presented as a declaration. Actual updates are recorded facts and live in
 * Recorded and Data.
 *
 * Mapping callbacks are named as roles for the same reason. The descriptor records that a subgraph
 * node invokes a graph; it does not record how parameters are built or how output is applied, and
 * nothing here invents it.
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
      rows.push({ label: 'parameters', value: inspectorCopy.parametersRole, tone: 'dim' });
      rows.push({ label: 'output', value: inspectorCopy.outputMappingRole, tone: 'dim' });
    }
    const outgoing = topology?.links.find(
      (link) => link.fromKey === element.key && link.destinationId === null,
    );
    const edge = outgoing ? topology?.elements.get(outgoing.toKey) : undefined;
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

function absentFromPin(): DockField {
  return { label: 'declared', value: inspectorCopy.absentFromCurrentPin, tone: 'warn' };
}

/* ── executions ────────────────────────────────────────────────────────────────────────────── */

function executionView(
  execution: WorkflowExecutionDto,
  state: WorkflowRunState,
  topology: DeclaredTopology | null,
  now: number,
): DockView {
  const ancestry = executionAncestry(state, execution);
  const key = elementKeyOf(ancestry.path, 'node', execution.nodeId);
  const element = topology?.elements.get(key);
  const visits = visitsOf(state, key);
  const timing = executionTiming(execution);
  const isSubgraph = execution.nodeKind === 'subgraph';

  const recorded: DockRow[] = [{ label: 'execution', value: String(execution.executionId) }];
  if (visits.length > 1) {
    recorded.push({
      label: 'visit',
      value: `${execution.visitIndex + 1} of ${visits.length}`,
    });
  }
  recorded.push(labelRow(execution.displayName, execution.labelDiagnostic));
  recorded.push(attemptsRow(execution));
  recorded.push({
    label: 'status',
    value: execution.status,
    tone: statusTone(execution.status),
  });
  recorded.push(pinRow(execution.firstArtifactHash, execution.latestArtifactHash));
  recorded.push(gap);
  recorded.push({ label: 'started', value: formatClock(execution.startedAt) });
  recorded.push(endedRow(execution.endedAt, execution.endCertainty));
  recorded.push(durationRow('duration', intervalDuration(timing.total, now), timing.total));
  recorded.push(durationRow('callback', intervalDuration(timing.callback, now), timing.callback));
  recorded.push(durationRow('wait', intervalDuration(timing.wait, now), timing.wait));

  if (execution.wait) {
    recorded.push(gap);
    recorded.push({
      label: 'wait',
      value: `${execution.wait.kind} · #${execution.wait.waitId}`,
      tone: execution.wait.status === 'armed' ? 'warn' : 'default',
    });
  }

  const failures = failureRows(execution);
  if (failures.length > 0) recorded.push(gap, ...failures);

  if (execution.routing) {
    recorded.push(gap);
    recorded.push(
      execution.routing.failure
        ? { label: 'routed', value: inspectorCopy.routingThrew, tone: 'bad' }
        : {
            label: 'routed',
            value: execution.routing.chosen ?? inspectorCopy.routingUndecided,
            tone: execution.routing.chosen === null ? 'warn' : 'ok',
          },
    );
    if (execution.routing.edgeId) {
      recorded.push({ label: 'edge', value: execution.routing.edgeId });
    }
  }

  const childFrame = execution.childFrame;
  if (isSubgraph && childFrame) {
    recorded.push(gap);
    recorded.push({ label: 'frame', value: String(childFrame.frameId) });
    recorded.push({ label: 'executions', value: String(childFrame.executionCount) });
    recorded.push(
      childFrame.output
        ? {
            label: 'output',
            value: `${childFrame.output.outcomeId} · ${childFrame.output.outcomeKind}`,
            tone: childFrame.output.outcomeKind === 'failure' ? 'bad' : 'ok',
            dataTab: 'output',
          }
        : { label: 'output', value: inspectorCopy.outputNotProduced, tone: 'warn' },
    );
  }

  const data: DockDataTab[] = [
    { kind: 'payload', key: 'state.in', name: 'state.in', slot: execution.stateInRef },
    { kind: 'payload', key: 'candidate', name: 'candidate', slot: execution.candidateRef },
    { kind: 'payload', key: 'update', name: 'update', slot: execution.updateRef },
    { kind: 'payload', key: 'state.out', name: 'state.out', slot: execution.stateOutRef },
  ];
  if (execution.routing?.updateRef !== undefined && execution.routing.updateRef !== null) {
    data.push({
      kind: 'payload',
      key: 'routing.update',
      name: 'routing.update',
      slot: execution.routing.updateRef,
    });
  }
  if (childFrame) {
    data.push({
      kind: 'payload',
      key: 'parameters',
      name: 'parameters',
      slot: childFrame.parametersRef,
    });
    if (childFrame.output)
      data.push({
        kind: 'payload',
        key: 'output',
        name: 'output',
        slot: childFrame.output.producedRef,
      });
  }
  if (execution.wait?.answers) {
    data.push({
      kind: 'payload',
      key: 'answers',
      name: 'answers',
      slot: { inline: execution.wait.answers },
    });
  }
  if (execution.checkpoint !== null) {
    data.push({
      kind: 'checkpoint_files',
      key: checkpointFilesTabKey,
      name: inspectorCopy.checkpointFilesTab,
      checkpointId: execution.checkpoint.checkpointId,
      fileCount: execution.checkpoint.counts.files,
    });
  }

  return {
    breadcrumb: breadcrumbFor(key, topology, execution),
    kindChip: execution.nodeKind,
    statusChip: statusLabel(execution),
    statusTone: statusTone(execution.status),
    // A checkpoint visit is named by the title its plan returned. That title is the checkpoint's,
    // not a label the step recorded, so it is read from the summary and never written back.
    displayName: execution.checkpoint?.title ?? execution.displayName,
    declared: element ? declaredFields(element, topology) : [absentFromPin()],
    recorded,
    operations: operationsMode(execution),
    data,
    executionId: execution.executionId,
    nested: isSubgraph
      ? {
          entered: childFrame !== null,
          executions: childFrame?.executionCount ?? 0,
          operations: childFrame === null ? 0 : nestedOperationCount(state, execution),
          children: childFrame === null ? [] : directChildren(state, childFrame.frameId),
        }
      : null,
    checkpoint:
      execution.nodeKind === 'checkpoint'
        ? {
            state: checkpointVisitState(execution),
            summary: execution.checkpoint,
            parent: (checkpointId) => checkpointVisitRef(state, execution, checkpointId),
          }
        : null,
  };
}

/**
 * The child frame's own executions, in the order they ran.
 *
 * Direct children only. Flattening every descendant into one list would turn a subgraph into a step
 * that made a lot of calls, which is exactly the conflation the inspector exists to prevent — a
 * nested subgraph among them is selected in turn, and opens its own.
 */
function directChildren(state: WorkflowRunState, frameId: number): readonly DockChildExecution[] {
  const children: DockChildExecution[] = [];
  for (const id of state.executionOrder) {
    const execution = state.executions.get(id);
    if (!execution || execution.frameId !== frameId) continue;
    children.push({
      executionId: execution.executionId,
      nodeId: execution.nodeId,
      displayName: execution.displayName,
      status: execution.status,
      isSubgraph: execution.nodeKind === 'subgraph',
      selection: { kind: 'execution', executionId: execution.executionId },
    });
  }
  return children;
}

/**
 * A node with a human wait keeps both.
 *
 * Replacing the operation list with the wait record would hide durable effects the node actually
 * made before it asked a question — and "it asked something" is not evidence that it called nothing.
 */
function operationsMode(execution: WorkflowExecutionDto): DockOperationsMode {
  if (execution.nodeKind === 'subgraph') {
    return { kind: 'none', reason: inspectorCopy.subgraphNoDirectOperations };
  }
  if (execution.wait === null) return { kind: 'operations' };

  const wait = execution.wait;
  const fields: DockRow[] = [
    { label: 'kind', value: wait.kind },
    { label: 'wait id', value: `#${wait.waitId}` },
    { label: 'status', value: wait.status, tone: wait.status === 'armed' ? 'warn' : 'ok' },
    { label: 'armed', value: formatClock(wait.armedAt) },
  ];
  if (wait.label) fields.push({ label: 'label', value: wait.label });
  for (const question of wait.questions ?? []) {
    fields.push({
      label: question.key,
      value: questionSummary(question),
    });
  }
  if (wait.status === 'armed') {
    fields.push(gap, { label: 'answered', value: inspectorCopy.waitOpen, tone: 'warn' });
    fields.push({ label: 'answer in', value: inspectorCopy.answerInTheBar, tone: 'dim' });
  } else {
    fields.push(gap, { label: 'delivered', value: formatClock(wait.deliveredAt), tone: 'ok' });
    for (const [key, value] of Object.entries(wait.answers ?? {})) {
      fields.push({
        label: key,
        value: Array.isArray(value) ? value.join(', ') : String(value),
        dataTab: 'answers',
      });
    }
  }
  return { kind: 'wait_and_operations', waitFields: fields };
}

function questionSummary(question: WorkflowQuestionSpecDto): string {
  if (question.kind !== 'select' && question.kind !== 'multi-select') return question.kind;
  // The option's own label when it has one, and its value otherwise — the value is what the answer
  // will actually be, so it is never wrong to show it.
  const options = question.options.map((option) => option.label ?? option.value).join(', ');
  return options === '' ? question.kind : `${question.kind} · ${options}`;
}

/* ── routing segments ──────────────────────────────────────────────────────────────────────── */

function routingView(
  execution: WorkflowExecutionDto,
  state: WorkflowRunState,
  topology: DeclaredTopology | null,
  now: number,
): DockView | null {
  const routing = execution.routing;
  if (!routing) return null;
  const ancestry = executionAncestry(state, execution);
  const key = routing.edgeId === null ? null : elementKeyOf(ancestry.path, 'edge', routing.edgeId);
  const element = key === null ? undefined : topology?.elements.get(key);
  const started = routing.startedAt;
  const duration =
    started === null
      ? null
      : Math.max(
          0,
          (routing.endedAt === null ? now : Date.parse(routing.endedAt)) - Date.parse(started),
        );

  const recorded: DockRow[] = [
    // The segment's identity is the execution that ran it plus its attempt. There is no durable
    // node-execution id for a routing segment, and synthesizing one would put a fabricated
    // identifier beside real ones.
    { label: 'segment', value: `routing · execution ${execution.executionId}` },
    { label: 'attempt', value: routing.attemptIndex === null ? '—' : String(routing.attemptIndex) },
    { label: 'arrived from', value: execution.nodeId },
    gap,
    { label: 'started', value: formatClock(routing.startedAt) },
    { label: 'ended', value: formatClock(routing.endedAt) },
    {
      label: 'duration',
      value: duration === null ? '—' : formatDuration(duration),
      tone: routing.endedAt === null && started !== null ? 'warn' : 'default',
    },
    gap,
  ];
  if (routing.failure) {
    recorded.push({ label: 'chose', value: inspectorCopy.routingThrew, tone: 'bad' });
    recorded.push({
      label: 'error',
      value: workflowFailureHeadline(routing.failure.code),
      tone: 'bad',
    });
    recorded.push({ label: 'code', value: routing.failure.code, tone: 'bad' });
    recorded.push({ label: 'message', value: routing.failure.message, tone: 'bad' });
    recorded.push({ label: 'repair', value: workflowCopy.retryPinNote, tone: 'warn' });
  } else {
    recorded.push({
      label: 'chose',
      value: routing.chosen ?? inspectorCopy.routingUndecided,
      tone: routing.chosen === null ? 'warn' : 'ok',
    });
  }

  return {
    breadcrumb: breadcrumbFor(key ?? '', topology, null),
    kindChip: 'edge',
    statusChip: routing.failure ? 'failed' : routing.endedAt === null ? 'running' : 'completed',
    statusTone: routing.failure ? 'bad' : 'ok',
    displayName: null,
    declared: element ? declaredFields(element, topology) : [absentFromPin()],
    recorded,
    operations: { kind: 'none', reason: inspectorCopy.edgesCannotCall },
    data:
      routing.updateRef === null
        ? []
        : [
            {
              kind: 'payload',
              key: 'routing.update',
              name: 'routing.update',
              slot: routing.updateRef,
            },
          ],
    executionId: null,
    nested: null,
    checkpoint: null,
  };
}

/* ── frame-owned segments ──────────────────────────────────────────────────────────────────── */

/**
 * A frame's own initialization and output evaluation.
 *
 * These are the two states a frame can be stuck in with no node execution to show for it — a graph
 * whose setup threw has no visit at all. Without a dock view of their own they would simply be
 * uninspectable, which is precisely the failure this column exists to prevent.
 */
function frameSegmentView(
  frame: WorkflowFrameDto,
  which: 'entry' | 'output',
  segment: WorkflowFrameSegmentDto | null,
  state: WorkflowRunState,
  now: number,
): DockView {
  const label = which === 'entry' ? 'graph entry' : 'graph output';
  if (segment === null) {
    return {
      breadcrumb: [{ label: frame.graphKey, displayName: frame.displayName }],
      kindChip: label,
      statusChip: inspectorCopy.notAttempted,
      statusTone: 'dim',
      displayName: frame.displayName,
      declared: [
        { label: 'kind', value: label },
        { label: 'graph', value: frame.graphKey },
        { label: 'frame', value: String(frame.frameId) },
      ],
      recorded: [{ label: 'status', value: inspectorCopy.notAttempted, tone: 'dim' }],
      operations: { kind: 'none', reason: inspectorCopy.frameSegmentNoOperations },
      data: [],
      executionId: null,
      nested: null,
      checkpoint: null,
    };
  }

  const interval =
    segment.endedAt === null && segment.endCertainty === 'unknown'
      ? null
      : Math.max(
          0,
          (segment.endedAt === null ? now : Date.parse(segment.endedAt)) -
            Date.parse(segment.startedAt),
        );

  const recorded: DockRow[] = [
    { label: 'segment', value: segment.segmentKind },
    { label: 'frame', value: String(frame.frameId) },
    {
      label: 'attempt',
      value:
        segment.attemptCount > 1
          ? `${segment.attemptCount} of ${segment.attemptCount} · latest shown`
          : '1 of 1',
      tone: segment.attemptCount > 1 ? 'warn' : 'default',
    },
    {
      label: 'status',
      value: segment.latestAttempt.status,
      tone: statusTone(segment.latestAttempt.status),
    },
    pinRow(segment.firstArtifactHash, segment.latestArtifactHash),
    gap,
    { label: 'started', value: formatClock(segment.startedAt) },
    endedRow(segment.endedAt, segment.endCertainty),
    {
      label: 'duration',
      value: interval === null ? inspectorCopy.durationUnknown : formatDuration(interval),
      tone: interval === null ? 'warn' : 'default',
    },
  ];
  if (segment.latestAttempt.failure) {
    recorded.push(gap);
    recorded.push({
      label: 'error',
      value: workflowFailureHeadline(segment.latestAttempt.failure.code),
      tone: 'bad',
    });
    recorded.push({ label: 'code', value: segment.latestAttempt.failure.code, tone: 'bad' });
    recorded.push({ label: 'message', value: segment.latestAttempt.failure.message, tone: 'bad' });
    recorded.push({ label: 'repair', value: workflowCopy.retryPinNote, tone: 'warn' });
  }
  for (const prior of segment.priorFailures) {
    recorded.push(gap);
    recorded.push({
      label: `attempt ${prior.attemptIndex}`,
      value: `${prior.failure.code} · ${prior.failure.message}`,
      tone: 'bad',
    });
    if (prior.repairedByAttemptIndex !== null) {
      recorded.push({
        label: 'repaired by',
        value: `attempt ${prior.repairedByAttemptIndex}${
          prior.repairedByArtifactHash ? ` · ${shortHash(prior.repairedByArtifactHash)}` : ''
        }`,
        tone: 'ok',
      });
    }
  }

  return {
    breadcrumb: [{ label: frame.graphKey, displayName: frame.displayName }],
    kindChip: label,
    statusChip: segment.latestAttempt.status,
    statusTone: statusTone(segment.latestAttempt.status),
    displayName: frame.displayName,
    declared: [
      { label: 'kind', value: label },
      { label: 'graph', value: frame.graphKey },
      { label: 'frame', value: String(frame.frameId) },
    ],
    recorded,
    operations: { kind: 'none', reason: inspectorCopy.frameSegmentNoOperations },
    data:
      which === 'entry'
        ? [
            { kind: 'payload', key: 'parameters', name: 'parameters', slot: frame.parametersRef },
            { kind: 'payload', key: 'state', name: 'state', slot: frame.stateRef },
          ]
        : [{ kind: 'payload', key: 'state', name: 'state', slot: frame.stateRef }],
    executionId: null,
    nested: null,
    checkpoint: null,
  };
}

function frameOutputView(frame: WorkflowFrameDto, state: WorkflowRunState, now: number): DockView {
  const output = frame.output;
  if (output === null) return frameSegmentView(frame, 'output', frame.outputEvaluation, state, now);

  return {
    breadcrumb: [{ label: frame.graphKey, displayName: frame.displayName }],
    kindChip: 'outcome',
    statusChip: output.outcomeKind,
    statusTone: output.outcomeKind === 'failure' ? 'bad' : 'ok',
    displayName: frame.displayName,
    declared: [
      { label: 'kind', value: 'outcome' },
      { label: 'id', value: output.outcomeId },
      { label: 'graph', value: frame.graphKey },
      { label: 'result', value: output.outcomeKind },
      ...(output.outcomeReason === null ? [] : [{ label: 'reason', value: output.outcomeReason }]),
    ],
    recorded: [
      { label: 'frame', value: String(frame.frameId) },
      { label: 'outcome', value: output.outcomeId },
      {
        label: 'result',
        value: output.outcomeKind,
        tone: output.outcomeKind === 'failure' ? 'bad' : 'ok',
      },
      ...(output.producerArtifactHash === null
        ? []
        : [{ label: 'produced by', value: shortHash(output.producerArtifactHash) }]),
      gap,
      { label: 'completed', value: formatClock(frame.completedAt) },
      { label: 'executions', value: String(frame.executionCount) },
    ],
    operations: { kind: 'none', reason: inspectorCopy.outcomesCannotCall },
    data: [
      { kind: 'payload', key: 'produced', name: 'produced', slot: output.producedRef },
      { kind: 'payload', key: 'state', name: 'state', slot: frame.stateRef },
    ],
    executionId: null,
    nested: null,
    checkpoint: null,
  };
}

/* ── shared rows ───────────────────────────────────────────────────────────────────────────── */

function labelRow(displayName: string | null, diagnostic: string | null): DockRow {
  if (diagnostic !== null) {
    // A failed capture is a diagnostic about a name, never a failed step. Saying which is the whole
    // point of the row: a missing name otherwise reads as a missing step.
    return { label: 'label', value: inspectorCopy.labelCaptureFailed(diagnostic), tone: 'warn' };
  }
  return displayName === null
    ? { label: 'label', value: '—', tone: 'dim' }
    : { label: 'label', value: displayName };
}

function attemptsRow(execution: WorkflowExecutionDto): DockRow {
  if (execution.attemptCount === 0) {
    return { label: 'attempt', value: inspectorCopy.noAttemptYet, tone: 'dim' };
  }
  return execution.attemptCount > 1
    ? {
        label: 'attempt',
        value: `${execution.attemptCount} of ${execution.attemptCount} · latest shown`,
        tone: 'warn',
      }
    : { label: 'attempt', value: '1 of 1' };
}

function failureRows(execution: WorkflowExecutionDto): readonly DockRow[] {
  const rows: DockRow[] = [];
  const latest = execution.latestAttempt;
  if (latest?.failure) {
    rows.push({
      label: 'failed',
      value: workflowFailureHeadline(latest.failure.code),
      tone: 'bad',
    });
    rows.push({ label: 'code', value: latest.failure.code, tone: 'bad' });
    rows.push({ label: 'message', value: latest.failure.message, tone: 'bad' });
    rows.push({ label: 'repair', value: workflowCopy.retryPinNote, tone: 'warn' });
  }
  if (latest && latest.recoveryMode === 'reuse_producer_output') {
    rows.push({
      label: 'recovery',
      value: inspectorCopy.reusedProducerOutput(latest.producerArtifactHash),
      tone: 'ok',
    });
  }
  for (const prior of execution.priorFailures) {
    rows.push(gap);
    rows.push({
      label: `attempt ${prior.attemptIndex}`,
      value: `${prior.segmentKind} · ${prior.failure.message}`,
      tone: 'bad',
    });
    rows.push(
      prior.repairedByAttemptIndex === null
        ? { label: 'repair', value: workflowCopy.retryPinNote, tone: 'warn' }
        : {
            label: 'repaired by',
            value: `attempt ${prior.repairedByAttemptIndex}${
              prior.repairedByArtifactHash ? ` · ${shortHash(prior.repairedByArtifactHash)}` : ''
            }`,
            tone: 'ok',
          },
    );
  }
  return rows;
}

/** A visit that started under one pin and was repaired under another reads as first → latest. */
function pinRow(first: string, latest: string): DockRow {
  return first === latest
    ? { label: 'pin', value: shortHash(latest) }
    : { label: 'pin', value: `${shortHash(first)} → ${shortHash(latest)}`, tone: 'warn' };
}

function endedRow(endedAt: string | null, certainty: 'observed' | 'unknown'): DockRow {
  if (endedAt !== null) return { label: 'ended', value: formatClock(endedAt) };
  return certainty === 'unknown'
    ? { label: 'ended', value: inspectorCopy.endUnknown, tone: 'warn' }
    : { label: 'ended', value: inspectorCopy.stillOpen, tone: 'warn' };
}

function durationRow(
  label: string,
  duration: number | null,
  interval: ReturnType<typeof executionTiming>['total'],
): DockRow {
  if (interval === null) return { label, value: '—', tone: 'dim' };
  if (duration === null) return { label, value: inspectorCopy.durationUnknown, tone: 'warn' };
  return interval.end.kind === 'open'
    ? { label, value: `${formatDuration(duration)} · ${inspectorCopy.soFar}`, tone: 'warn' }
    : { label, value: formatDuration(duration) };
}

function statusLabel(execution: WorkflowExecutionDto): string {
  if (execution.status === 'failed') return 'failed';
  if (execution.priorFailures.some((prior) => prior.repairedByAttemptIndex !== null)) {
    return 'repaired';
  }
  return execution.status;
}

function statusTone(status: string): FieldTone {
  switch (status) {
    case 'failed':
      return 'bad';
    case 'completed':
    case 'succeeded':
      return 'ok';
    case 'running':
    case 'awaiting':
    case 'routing':
    case 'mapping':
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

function elementKeyOf(path: readonly string[], kind: 'node' | 'edge', id: string): string {
  return `${path.join('/')}::${kind}:${id}`;
}

function breadcrumbFor(
  key: string,
  topology: DeclaredTopology | null,
  execution: WorkflowExecutionDto | null,
): DockView['breadcrumb'] {
  const crumbs: { label: string; displayName: string | null }[] = [];
  if (topology) {
    for (const ancestor of ancestorKeys(topology, key)) {
      const element = topology.elements.get(ancestor);
      if (element) crumbs.push({ label: element.address.id, displayName: null });
    }
  }
  const self = topology?.elements.get(key);
  const id = self?.address.id ?? execution?.nodeId ?? key;
  crumbs.push({ label: id, displayName: execution?.displayName ?? null });
  if (execution && execution.visitIndex > 0) {
    crumbs.push({ label: `visit ${execution.visitIndex + 1}`, displayName: null });
  }
  return crumbs;
}

function nestedOperationCount(state: WorkflowRunState, subgraph: WorkflowExecutionDto): number {
  let total = 0;
  const frames = new Set<number>();
  if (subgraph.childFrameId !== null) frames.add(subgraph.childFrameId);
  let grew = true;
  while (grew) {
    grew = false;
    for (const frame of state.frames.values()) {
      if (frames.has(frame.frameId)) continue;
      const parent = frame.parentExecutionId;
      if (parent === null) continue;
      const parentExecution = state.executions.get(parent);
      if (parentExecution && frames.has(parentExecution.frameId)) {
        frames.add(frame.frameId);
        grew = true;
      }
    }
  }
  for (const execution of state.executions.values()) {
    if (frames.has(execution.frameId)) total += execution.operationSummary.count;
  }
  return total;
}

/**
 * A pin, short enough to sit in a dense row and still identify itself.
 *
 * The algorithm prefix is dropped first. A bare seven-character slice of `sha256:abc…` is the seven
 * characters every hash in the system shares, which identifies nothing at all.
 */
export function shortHash(hash: string): string {
  const separator = hash.indexOf(':');
  const digest = separator === -1 ? hash : hash.slice(separator + 1);
  return digest.slice(0, 7);
}
