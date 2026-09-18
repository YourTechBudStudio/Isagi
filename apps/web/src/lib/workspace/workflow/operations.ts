import type { QueryClient } from '@tanstack/react-query';

import type { ListWorkflowOperationsOutput, WorkflowOperationDto } from '@isagi/contracts';

import { mergeMissingOperations, type WorkflowRunState } from './model.js';

/**
 * On-demand hydration of one visit's durable operations.
 *
 * The run listing deliberately carries no operation rows: an execution states how many operations
 * it made and which capabilities it called, and the cards themselves are read for the one visit a
 * person selected. Live deltas and gap recoveries do carry operation rows, so a run watched from the
 * start accumulates them — but a run opened after the fact has none of its history's operations, and
 * the dock would show an empty list beside a count of four.
 *
 * So this fills the hole, under rules that keep the canonical projection the only thing rendered:
 *
 * - every page is read before anything is written, so a partial read never looks like a complete
 *   list;
 * - the write inserts only keys the projection does not already have, so a point-in-time read can
 *   never overwrite a revision-ordered fact — a fetched `dispatched` cannot bury a settled
 *   `completed`;
 * - the result is completion metadata, not a second copy of the rows. There is exactly one map of
 *   operations in the client and it is the one the coordinator owns.
 */

/** What a completed hydration knows. Deliberately not the rows: those live in the projection. */
export interface WorkflowOperationsHydration {
  readonly executionId: number;
  /** The keys this read accounted for, complete across every page. */
  readonly operationKeys: readonly string[];
  readonly pageCount: number;
  /** The epoch the rows were merged into. A later baseline replacement re-keys and re-reads. */
  readonly hydrationEpoch: number;
}

export interface OperationsPageReader {
  (input: {
    readonly runId: number;
    readonly executionId: number;
    readonly limit: number;
    readonly cursor: string | null;
  }): Promise<ListWorkflowOperationsOutput>;
}

/**
 * Reads every page for one execution and commits them in a single write.
 *
 * `readState`/`writeState` are the projection's cache entry rather than a `QueryClient` so the whole
 * protocol — all pages first, missing keys only, epoch still current — is testable without React.
 */
export async function hydrateExecutionOperations(input: {
  readonly runId: number;
  readonly executionId: number;
  readonly hydrationEpoch: number;
  readonly pageSize?: number | undefined;
  readonly read: OperationsPageReader;
  readonly readState: () => WorkflowRunState | undefined;
  readonly writeState: (update: (state: WorkflowRunState) => WorkflowRunState) => void;
  readonly signal?: AbortSignal | undefined;
}): Promise<WorkflowOperationsHydration> {
  const rows: WorkflowOperationDto[] = [];
  let cursor: string | null = null;
  let pageCount = 0;

  do {
    const page: ListWorkflowOperationsOutput = await input.read({
      runId: input.runId,
      executionId: input.executionId,
      limit: input.pageSize ?? 100,
      cursor,
    });
    pageCount += 1;
    rows.push(...page.items);
    cursor = page.nextCursor;
    // A selection that moved on, or a consumer that unmounted, must not keep paging — and must
    // certainly not commit. Thrown rather than returned partially: a partial read is not an answer.
    input.signal?.throwIfAborted();
  } while (cursor !== null);

  // The projection may have been replaced while this was in flight. Committing into the new one
  // would insert rows read against a baseline that no longer exists; the re-keyed read replaces it.
  const current = input.readState();
  if (current !== undefined && current.hydrationEpoch !== input.hydrationEpoch) {
    throw new WorkflowOperationsStaleError(input.hydrationEpoch, current.hydrationEpoch);
  }

  input.writeState((state) => mergeMissingOperations(state, rows));

  return {
    executionId: input.executionId,
    operationKeys: rows.map((row) => row.operationKey),
    pageCount,
    hydrationEpoch: input.hydrationEpoch,
  };
}

/**
 * The baseline this read was taken against has been replaced.
 *
 * Its own error for the same reason a stale structure read has one: nothing went wrong except that
 * the question is out of date. The query is keyed on the epoch, so the replacement has already
 * asked again.
 */
export class WorkflowOperationsStaleError extends Error {
  constructor(
    readonly readEpoch: number,
    readonly currentEpoch: number,
  ) {
    super(
      `Operations were read against hydration epoch ${readEpoch}; the run is now on ${currentEpoch}.`,
    );
    this.name = 'WorkflowOperationsStaleError';
  }
}

/** The projection cache accessors, bound to one run's key. */
export function runStateAccessors(queryClient: QueryClient, key: readonly unknown[]) {
  return {
    readState: () => queryClient.getQueryData<WorkflowRunState>(key),
    writeState: (update: (state: WorkflowRunState) => WorkflowRunState) => {
      queryClient.setQueryData<WorkflowRunState>(key, (current) =>
        current === undefined ? current : update(current),
      );
    },
  };
}
