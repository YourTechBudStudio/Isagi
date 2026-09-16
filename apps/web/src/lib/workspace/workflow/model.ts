import type {
  ListRunExecutionsOutput,
  WorkflowExecutionDto,
  WorkflowFrameDto,
  WorkflowOperationDto,
  WorkflowRunSummary,
  WorkflowRunTransitionDelta,
} from '@isagi/contracts';

/**
 * The one synchronized projection of a run.
 *
 * Entity maps plus a stable execution order, and the revision coverage those facts actually stand
 * on. Everything a consumer needs is selected from here: there is no second mutable cache of a
 * frame, an execution or an operation anywhere in the client, because two caches of the same fact
 * are two answers to the same question.
 *
 * `coverageRevision` is the last revision whose effects are fully present. A delta applies only at
 * exactly `coverageRevision + 1`; anything else is a duplicate to drop or a gap to recover. Nothing
 * else may advance it — not a summary pushed on the side, and not the bar's log window.
 */
/**
 * A pause the run actually recorded.
 *
 * Kept because it lives only in history — no entity row carries it — and because it is bounded by
 * how often a person pauses, not by how long the run is. `openedAtRevision` is the identity, so a
 * replayed or duplicated transition cannot open the same band twice.
 */
export interface WorkflowPauseInterval {
  readonly openedAtRevision: number;
  readonly openedAt: string;
  readonly closedAt: string | null;
  /** The revision that closed it, so a replayed close lands on the band it actually ended. */
  readonly closedAtRevision: number | null;
}

/** A pin the run adopted, in adoption order. The latest one is the pin Declared must draw. */
export interface WorkflowPinAdoption {
  readonly revision: number;
  readonly artifactHash: string;
  readonly adoptedAt: string;
}

export interface WorkflowRunState {
  readonly runId: number;
  readonly summary: WorkflowRunSummary | null;
  readonly executions: ReadonlyMap<number, WorkflowExecutionDto>;
  /** Execution ids in `(startedAt, executionId)` order, independent of arrival order. */
  readonly executionOrder: readonly number[];
  readonly frames: ReadonlyMap<number, WorkflowFrameDto>;
  readonly operations: ReadonlyMap<string, WorkflowOperationDto>;
  readonly pauseIntervals: readonly WorkflowPauseInterval[];
  readonly pinAdoptions: readonly WorkflowPinAdoption[];
  readonly coverageRevision: number;
  /** False until a coherent baseline has been established at `coverageRevision`. */
  readonly hydrated: boolean;
  /**
   * How many times a *fresh* baseline has replaced this projection.
   *
   * A gap fill only ever adds facts, so it cannot invalidate anything a consumer derived. A fresh
   * baseline is different: it starts from nothing and can legitimately come back without rows the
   * previous one had. Anything hydrated on demand beside this projection — operation cards for a
   * selected visit, today — is keyed on this number, so a replacement re-asks instead of trusting
   * a fill it can no longer account for. Making it an observable fact is the point; inferring
   * "the baseline was replaced" from a revision going backwards would be a guess.
   */
  readonly hydrationEpoch: number;
  /**
   * The last recovery pass that failed, if one did.
   *
   * Recorded rather than logged: a failed recovery leaves this projection behind the runtime, and a
   * consumer that cannot see that would present stale history as current. Cleared by the next pass
   * that commits.
   */
  readonly recoveryError: unknown;
}

export type DeltaOutcome = 'applied' | 'duplicate' | 'gap';

export function emptyRunState(runId: number): WorkflowRunState {
  return {
    runId,
    summary: null,
    executions: new Map(),
    executionOrder: [],
    frames: new Map(),
    operations: new Map(),
    pauseIntervals: [],
    pinAdoptions: [],
    coverageRevision: 0,
    hydrated: false,
    hydrationEpoch: 0,
    recoveryError: null,
  };
}

/**
 * The empty state a fresh baseline is built in, carrying the epoch forward.
 *
 * A fresh baseline deliberately inherits no rows — a replayed full hydration must not keep facts the
 * runtime has stopped reporting — but the epoch is not a row. It has to survive, or every
 * replacement would look like the first one and nothing could tell that a replacement happened.
 */
export function freshBaselineState(previous: WorkflowRunState): WorkflowRunState {
  return { ...emptyRunState(previous.runId), hydrationEpoch: previous.hydrationEpoch + 1 };
}

/**
 * Inserts operation rows this projection does not already have, and never touches one it does.
 *
 * On-demand hydration exists because the baseline listing deliberately carries no operations: an
 * execution states how many it made, and the cards for the one visit a person selected are read
 * separately. Those rows are point-in-time reads with no revision of their own, while everything
 * already here arrived through revision-ordered coverage. So coverage wins, always — a fetched
 * `dispatched` can never overwrite a settled `completed` that a delta has already applied.
 */
export function mergeMissingOperations(
  state: WorkflowRunState,
  rows: readonly WorkflowOperationDto[],
): WorkflowRunState {
  const missing = rows.filter((row) => !state.operations.has(row.operationKey));
  if (missing.length === 0) return state;
  const operations = new Map(state.operations);
  for (const row of missing) operations.set(row.operationKey, row);
  return { ...state, operations };
}

/**
 * Applies one page of a baseline or gap-recovery read.
 *
 * Coverage is deliberately *not* advanced here. A page is only part of a batch, and claiming a
 * revision before the last page has landed is the exact failure the recovery boundary exists to
 * prevent: a client that acknowledges a revision it was never given skips the real deltas forever.
 */
export function applyExecutionsPage(
  state: WorkflowRunState,
  page: ListRunExecutionsOutput,
): WorkflowRunState {
  const withRows = upsertExecutions(state, page.items);
  const withFrames = upsertFrames(withRows, page.changes.frames);
  const withOperations = upsertOperations(withFrames, page.changes.operations);
  return page.changes.summary === undefined
    ? withOperations
    : applySummary(withOperations, page.changes.summary);
}

/** Marks the state coherent at a revision every page of a batch has been consumed up to. */
export function withCoverage(state: WorkflowRunState, revision: number): WorkflowRunState {
  // A pass that reaches here succeeded, so any recorded failure is spent.
  if (revision < state.coverageRevision) {
    return { ...state, hydrated: true, recoveryError: null };
  }
  return { ...state, coverageRevision: revision, hydrated: true, recoveryError: null };
}

export function applyDelta(
  state: WorkflowRunState,
  delta: WorkflowRunTransitionDelta,
): { readonly state: WorkflowRunState; readonly outcome: DeltaOutcome } {
  if (!state.hydrated) return { state, outcome: 'gap' };
  if (delta.revision <= state.coverageRevision) return { state, outcome: 'duplicate' };
  if (delta.revision !== state.coverageRevision + 1) return { state, outcome: 'gap' };

  const withRows = upsertExecutions(state, delta.changes.executions);
  const withFrames = upsertFrames(withRows, delta.changes.frames);
  const withOperations = upsertOperations(withFrames, delta.changes.operations);
  const withSummary =
    delta.changes.summary === undefined
      ? withOperations
      : applySummary(withOperations, delta.changes.summary);
  return {
    state: { ...withSummary, coverageRevision: delta.revision },
    outcome: 'applied',
  };
}

/**
 * Accepts a summary that is not older than the one held.
 *
 * Summaries reach the client by two routes — inside a delta, and as the surface-level
 * `workflow_run_changed` — and they can therefore arrive out of order. Revision decides, so a late
 * response can never reinstate a state the run has already left.
 */
export function applySummary(
  state: WorkflowRunState,
  summary: WorkflowRunSummary,
): WorkflowRunState {
  if (summary.runId !== state.runId) return state;
  if (state.summary && summary.revision < state.summary.revision) return state;
  return { ...state, summary };
}

function upsertExecutions(
  state: WorkflowRunState,
  rows: readonly WorkflowExecutionDto[],
): WorkflowRunState {
  if (rows.length === 0) return state;
  const executions = new Map(state.executions);
  let order: number[] | null = null;
  for (const row of rows) {
    if (!executions.has(row.executionId)) {
      order ??= [...state.executionOrder];
      insertInOrder(order, row, executions);
    }
    executions.set(row.executionId, row);
  }
  return {
    ...state,
    executions,
    ...(order === null ? {} : { executionOrder: order }),
  };
}

/**
 * `(startedAt, executionId)` are immutable on an execution row, so a visit never moves once placed
 * and only a genuinely new id costs an insert. Binary search keeps arrival order irrelevant: rows
 * recovered out of order land exactly where a full re-read would have put them.
 */
function insertInOrder(
  order: number[],
  row: WorkflowExecutionDto,
  executions: ReadonlyMap<number, WorkflowExecutionDto>,
) {
  let low = 0;
  let high = order.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const existing = executions.get(order[mid]!);
    if (existing && compareExecutions(existing, row) <= 0) low = mid + 1;
    else high = mid;
  }
  order.splice(low, 0, row.executionId);
}

function compareExecutions(left: WorkflowExecutionDto, right: WorkflowExecutionDto): number {
  if (left.startedAt !== right.startedAt) return left.startedAt < right.startedAt ? -1 : 1;
  return left.executionId - right.executionId;
}

function upsertFrames(
  state: WorkflowRunState,
  rows: readonly WorkflowFrameDto[],
): WorkflowRunState {
  if (rows.length === 0) return state;
  const frames = new Map(state.frames);
  for (const row of rows) frames.set(row.frameId, row);
  return { ...state, frames };
}

function upsertOperations(
  state: WorkflowRunState,
  rows: readonly WorkflowOperationDto[],
): WorkflowRunState {
  if (rows.length === 0) return state;
  const operations = new Map(state.operations);
  for (const row of rows) operations.set(row.operationKey, row);
  return { ...state, operations };
}

export function orderedExecutions(state: WorkflowRunState): readonly WorkflowExecutionDto[] {
  return state.executionOrder.flatMap((id) => {
    const execution = state.executions.get(id);
    return execution ? [execution] : [];
  });
}

/**
 * Membership is derived from current operation facts rather than cached per filter, so an operation
 * that settles moves between filtered views without a second read and without two caches disagreeing
 * about which list it belongs to.
 */
export function selectOperations(
  state: WorkflowRunState,
  filters: { readonly executionId?: number | undefined; readonly state?: string | undefined } = {},
): readonly WorkflowOperationDto[] {
  const rows: WorkflowOperationDto[] = [];
  for (const operation of state.operations.values()) {
    if (filters.executionId !== undefined && operation.executionId !== filters.executionId)
      continue;
    if (filters.state !== undefined && operation.state !== filters.state) continue;
    rows.push(operation);
  }
  return rows.sort(
    (left, right) =>
      left.executionId - right.executionId ||
      left.callIndex - right.callIndex ||
      left.operationKey.localeCompare(right.operationKey),
  );
}
