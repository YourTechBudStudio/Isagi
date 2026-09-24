import type { QueryClient } from '@tanstack/react-query';

import type {
  GetWorkflowRunOutput,
  ListRunExecutionsOutput,
  ListRunExecutionsQuery,
  ListWorkflowEventsOutput,
  ListWorkflowEventsQuery,
  WorkflowRunTransitionDelta,
} from '@isagi/contracts';

import { runRuntimeEffect } from '../../runtime/run.js';
import { workflowRunStateQueryKey } from '../query-keys.js';
import { getWorkflowRun, listWorkflowEvents, listWorkflowExecutions } from '../runtime-data.js';
import {
  applyDelta,
  applyExecutionsPage,
  applySummary,
  emptyRunState,
  freshBaselineState,
  withCoverage,
  type WorkflowRunState,
} from './model.js';
import { subscribeToWorkflowSignals } from './signals.js';
import { applyTransitionFacts, type WorkflowRunFacts } from './transition-facts.js';

/**
 * The three reads a synchronization pass makes.
 *
 * Named as a port so a test drives the protocol — contiguity, buffering, one serialized recovery —
 * against scripted pages instead of a live runtime. The protocol is the part that can be wrong; the
 * transport is not what these tests are about.
 */
export interface WorkflowReadPort {
  readonly getRun: (runId: number) => Promise<GetWorkflowRunOutput>;
  readonly listExecutions: (
    runId: number,
    query: ListRunExecutionsQuery,
  ) => Promise<ListRunExecutionsOutput>;
  readonly listEvents: (
    runId: number,
    query: ListWorkflowEventsQuery,
  ) => Promise<ListWorkflowEventsOutput>;
}

export const runtimeWorkflowReadPort: WorkflowReadPort = {
  getRun: (runId) => runRuntimeEffect(getWorkflowRun(runId)),
  listExecutions: (runId, query) => runRuntimeEffect(listWorkflowExecutions(runId, query)),
  listEvents: (runId, query) => runRuntimeEffect(listWorkflowEvents(runId, query)),
};

export interface RunSynchronizerOptions {
  readonly queryClient: QueryClient;
  readonly runtimeIdentity: string;
  readonly runId: number;
  /** Page size for the baseline and recovery reads. The route caps this itself. */
  readonly pageSize?: number | undefined;
  readonly reads?: WorkflowReadPort | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
}

/**
 * Keeps one run's canonical projection in step with the runtime, and owns the bookkeeping that
 * makes that possible: buffering, contiguity, and one serialized recovery at a time.
 *
 * It holds no domain rows of its own. Every fact it learns goes straight into the React Query cache
 * that hooks read, so the cache stays the single authority and this object stays a protocol, not a
 * second store.
 *
 * Start order matters and is not incidental: the subscription is registered *before* the baseline
 * is requested, so a transition committed while the baseline is in flight is buffered rather than
 * lost. Hydrating first and subscribing second would drop exactly the revisions a live run is
 * producing at that moment.
 */
export class RunSynchronizer {
  private readonly queryClient: QueryClient;
  private readonly runtimeIdentity: string;
  private readonly runId: number;
  private readonly pageSize: number;
  private readonly reads: WorkflowReadPort;
  private readonly onError: ((error: unknown) => void) | undefined;

  private unsubscribe: (() => void) | null = null;
  private stopped = false;
  /** Deltas that arrived while a baseline or recovery was in flight. Drained in arrival order. */
  private buffered: WorkflowRunTransitionDelta[] = [];
  private recovering = false;
  /** A gap seen during a recovery. One more pass runs after the current one, never concurrently. */
  private recoveryPending = false;
  /**
   * Bumped whenever this synchronizer stops. A pass captures it before its first await and drops
   * its result if it no longer matches, so work in flight when a consumer unmounts cannot land on
   * whatever replaced it.
   */
  private generation = 0;

  constructor(options: RunSynchronizerOptions) {
    this.queryClient = options.queryClient;
    this.runtimeIdentity = options.runtimeIdentity;
    this.runId = options.runId;
    this.pageSize = options.pageSize ?? 100;
    this.reads = options.reads ?? runtimeWorkflowReadPort;
    this.onError = options.onError;
  }

  start() {
    if (this.unsubscribe) return;
    this.unsubscribe = subscribeToWorkflowSignals((signal) => {
      if (this.stopped) return;
      switch (signal.type) {
        case 'transition':
          if (signal.delta.runId === this.runId) this.receive(signal.delta);
          break;
        case 'run_changed':
          // Surface-level bookkeeping, not delta coverage: it may update the summary if it is not
          // older, and it must never move the watermark, or the next real delta would be skipped.
          if (signal.summary.runId === this.runId) {
            this.write((state) => applySummary(state, signal.summary));
          }
          break;
        case 'connected':
          // Unconditional, because a reconnect cannot prove nothing was missed while it was down.
          void this.recover();
          break;
        case 'recovery_requested':
          // A consumer noticed it was behind. Recovery still runs here, serialized with every other
          // pass, so two observers of the same staleness cannot start two overlapping fills.
          if (signal.runId === this.runId) void this.recover();
          break;
        default:
          break;
      }
    });
    void this.hydrate();
  }

  stop() {
    this.stopped = true;
    this.generation += 1;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.buffered = [];
  }

  /** Exposed for tests and for a consumer that wants to force a fresh coherent baseline. */
  async hydrate() {
    await this.runRecovery(null);
  }

  private receive(delta: WorkflowRunTransitionDelta) {
    if (this.recovering) {
      this.buffered.push(delta);
      return;
    }
    const outcome = this.apply(delta);
    if (outcome === 'gap') void this.recover();
  }

  private apply(delta: WorkflowRunTransitionDelta): 'applied' | 'duplicate' | 'gap' {
    let outcome: 'applied' | 'duplicate' | 'gap' = 'duplicate';
    this.write((state) => {
      const result = applyDelta(state, delta);
      outcome = result.outcome;
      return result.outcome === 'applied'
        ? applyTransitionFacts(result.state, delta)
        : result.state;
    });
    return outcome;
  }

  private async recover() {
    const state = this.read();
    await this.runRecovery(state.hydrated ? state.coverageRevision : null);
  }

  /**
   * One pass, serialized.
   *
   * `sinceRevision === null` is a fresh baseline; a number is a gap fill from the last revision the
   * cache genuinely covers. Either way every page of both reads is consumed before coverage moves,
   * and coverage lands on the *lower* of the two batches' watermarks — acknowledging the higher one
   * would claim revisions the other read never delivered.
   */
  private async runRecovery(sinceRevision: number | null) {
    if (this.recovering) {
      this.recoveryPending = true;
      return;
    }
    this.recovering = true;
    try {
      do {
        this.recoveryPending = false;
        await this.fetchBaseline(sinceRevision);
        sinceRevision = this.read().coverageRevision;
      } while (this.recoveryPending && !this.stopped);
    } catch (error) {
      // Recorded on the run, not swallowed into an optional callback nobody supplies. A recovery
      // that failed leaves the cache behind the runtime, and a consumer that cannot tell would
      // present stale history as current.
      this.write((state) => ({ ...state, recoveryError: error }));
      this.onError?.(error);
    } finally {
      this.recovering = false;
      this.drain();
    }
  }

  /**
   * One pass, built in a candidate state and committed once.
   *
   * The reads land over many round trips, and a pass can be abandoned midway — the consumer
   * unmounts, the runtime changes, a page fails. Writing each page into the live cache as it
   * arrived meant observers could see a half-applied boundary, and an abandoned pass could still
   * overwrite rows a newer pass had already written. Entity rows carry no revision of their own, so
   * nothing downstream could have sorted that out afterwards.
   *
   * So the pass accumulates privately and commits under a generation fence: if the synchronizer
   * stopped, or another pass has since moved coverage, the result is dropped whole rather than
   * merged. A recovery either happened or it did not.
   */
  private async fetchBaseline(sinceRevision: number | null) {
    const generation = this.generation;
    const committed = this.read();
    // A gap fill builds on what is already acknowledged; a fresh baseline builds on nothing, so a
    // replayed full hydration cannot inherit facts the runtime is no longer reporting.
    let candidate: WorkflowRunState =
      sinceRevision === null ? freshBaselineState(committed) : committed;

    if (sinceRevision === null) {
      const run = await this.reads.getRun(this.runId);
      candidate = applySummary(candidate, run.run);
    }

    const executions = await this.readAllPages<ListRunExecutionsOutput>((cursor) =>
      // `sinceRevision` is what selects gap-recovery mode on this route; omitting it asks for the
      // full hydration listing. The cursor carries the frozen boundary for every page after the
      // first, so the bound is sent once and never restated.
      this.reads.listExecutions(this.runId, {
        limit: this.pageSize,
        ...(cursor === null ? {} : { cursor }),
        ...(cursor === null && sinceRevision !== null ? { sinceRevision } : {}),
      }),
    );
    for (const page of executions.pages) candidate = applyExecutionsPage(candidate, page);

    // The second read rides the first one's frozen boundary, so the two describe one moment. Pause
    // bands and pin adoptions live only in history, and without this pass a reconnecting client
    // would draw a run that was never paused.
    const snapshotToken = executions.pages[0]?.boundary.snapshotToken;
    const events = await this.readAllPages<ListWorkflowEventsOutput>((cursor) =>
      this.reads.listEvents(this.runId, {
        limit: this.pageSize,
        ...(cursor === null
          ? {
              sinceRevision: sinceRevision ?? 0,
              ...(snapshotToken === undefined ? {} : { snapshotToken }),
            }
          : { cursor }),
      }),
    );
    for (const page of events.pages) {
      for (const delta of page.items) candidate = applyTransitionFacts(candidate, delta);
    }

    const coverage = Math.min(
      executions.coverageRevision ?? 0,
      events.coverageRevision ?? executions.coverageRevision ?? 0,
    );
    candidate = withCoverage(candidate, coverage);

    this.commit(generation, candidate);
  }

  /**
   * Publishes a completed pass, or drops it.
   *
   * Dropped when this synchronizer has stopped, or when the cache has moved past where the pass
   * started — both mean the result describes a world somebody else has already replaced.
   */
  private commit(generation: number, candidate: WorkflowRunState) {
    if (this.stopped || generation !== this.generation) return;
    this.queryClient.setQueryData<WorkflowRunState>(this.key(), (current) => {
      if (current && current.coverageRevision > candidate.coverageRevision) return current;
      // A summary pushed while the pass was in flight is newer than anything the pass read. The
      // candidate replaces the whole state, so without this the commit would rewind it — briefly,
      // since the matching transition usually restores it, but an authoritative cache that goes
      // backwards at all is one a synchronous observer can catch doing it.
      return current?.summary ? applySummary(candidate, current.summary) : candidate;
    });
  }

  private async readAllPages<
    Page extends {
      readonly boundary: { readonly coverageRevision: number };
      readonly nextCursor: string | null;
    },
  >(
    fetchPage: (cursor: string | null) => Promise<Page>,
  ): Promise<{ readonly pages: readonly Page[]; readonly coverageRevision: number | null }> {
    const pages: Page[] = [];
    let cursor: string | null = null;
    do {
      const page: Page = await fetchPage(cursor);
      pages.push(page);
      cursor = page.nextCursor;
    } while (cursor !== null && !this.stopped);
    return {
      pages,
      coverageRevision: pages.at(-1)?.boundary.coverageRevision ?? null,
    };
  }

  /** Replays what arrived during a recovery, in order, and starts another pass on a real gap. */
  private drain() {
    const queued = this.buffered;
    this.buffered = [];
    for (const delta of queued) {
      if (this.stopped) return;
      if (this.apply(delta) === 'gap') {
        void this.recover();
        return;
      }
    }
  }

  private read(): WorkflowRunState {
    return this.queryClient.getQueryData<WorkflowRunState>(this.key()) ?? emptyRunState(this.runId);
  }

  private write(update: (state: WorkflowRunState) => WorkflowRunState) {
    if (this.stopped) return;
    this.queryClient.setQueryData<WorkflowRunState>(this.key(), (current) =>
      update(current ?? emptyRunState(this.runId)),
    );
  }

  private key() {
    return workflowRunStateQueryKey(this.runtimeIdentity, this.runId);
  }
}

export type { WorkflowRunFacts };
