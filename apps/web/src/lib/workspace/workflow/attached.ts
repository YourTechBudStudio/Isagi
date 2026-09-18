import type { QueryClient } from '@tanstack/react-query';

import type { WorkflowRunSummary } from '@isagi/contracts';

import { workflowAttachedRunsQueryKey } from '../query-keys.js';
import { subscribeToWorkflowSignals, type WorkflowSignal } from './signals.js';

export type AttachedRuns = readonly WorkflowRunSummary[];

/**
 * The snapshot is the baseline, not a merge.
 *
 * It is the runtime's complete answer to "which runs occupy a surface right now", so a run it does
 * not mention is not attached — keeping a remembered one would leave a bar on a surface the runtime
 * says is free.
 */
export function replaceAttached(summaries: AttachedRuns): AttachedRuns {
  return summaries.filter(isAttached);
}

/**
 * A summary is accepted when it is not older than the one held, and a run that has stopped
 * occupying a surface leaves the list. Revision decides, because these arrive on a push and can
 * overtake each other.
 */
export function upsertAttached(current: AttachedRuns, summary: WorkflowRunSummary): AttachedRuns {
  const index = current.findIndex((run) => run.runId === summary.runId);
  if (index === -1) return isAttached(summary) ? [...current, summary] : current;
  if (summary.revision < current[index]!.revision) return current;
  if (!isAttached(summary)) return current.filter((run) => run.runId !== summary.runId);
  const next = [...current];
  next[index] = summary;
  return next;
}

/**
 * A detach releases one run's occupancy of one surface.
 *
 * It removes the run only while that run is still the one the surface holds: a detach for an
 * earlier run arriving late must not take down the run that has since replaced it.
 */
export function detachAttached(
  current: AttachedRuns,
  input: { readonly runId: number; readonly surfaceId: number | null },
): AttachedRuns {
  const occupant = current.find((run) => run.runId === input.runId);
  if (!occupant) return current;
  if (input.surfaceId !== null && occupant.attachment?.surfaceId !== input.surfaceId) {
    return current;
  }
  return current.filter((run) => run.runId !== input.runId);
}

export function attachedRunForSurface(
  runs: AttachedRuns | undefined,
  surfaceId: number | null | undefined,
): WorkflowRunSummary | undefined {
  if (!runs || surfaceId === null || surfaceId === undefined) return undefined;
  return runs.find((run) => run.attachment?.surfaceId === surfaceId);
}

function isAttached(summary: WorkflowRunSummary): boolean {
  return summary.attachment !== null;
}

/**
 * Keeps the attached-run cache in step with the shared connection.
 *
 * Changed and detached events that arrive before the baseline are buffered and replayed after it,
 * so a run that started while the snapshot was in flight is not erased by the snapshot that
 * predates it. This is the same ordering rule the per-run coordinator follows, for the same reason.
 */
export class AttachedRunsSync {
  private readonly queryClient: QueryClient;
  private readonly runtimeIdentity: string;
  private unsubscribe: (() => void) | null = null;
  private hydrating = true;
  private buffered: WorkflowSignal[] = [];

  constructor(queryClient: QueryClient, runtimeIdentity: string) {
    this.queryClient = queryClient;
    this.runtimeIdentity = runtimeIdentity;
  }

  start() {
    if (this.unsubscribe) return;
    this.unsubscribe = subscribeToWorkflowSignals((signal) => this.receive(signal));
  }

  stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.buffered = [];
  }

  read(): AttachedRuns {
    return this.queryClient.getQueryData<AttachedRuns>(this.key()) ?? [];
  }

  private receive(signal: WorkflowSignal) {
    switch (signal.type) {
      case 'connected':
        this.hydrating = true;
        this.buffered = [];
        break;
      case 'snapshot':
        this.write(() => replaceAttached(signal.summaries));
        this.hydrating = false;
        for (const buffered of this.buffered) this.applyChange(buffered);
        this.buffered = [];
        break;
      case 'run_changed':
      case 'run_detached':
        if (this.hydrating) this.buffered.push(signal);
        else this.applyChange(signal);
        break;
      default:
        break;
    }
  }

  private applyChange(signal: WorkflowSignal) {
    if (signal.type === 'run_changed') {
      this.write((current) => upsertAttached(current, signal.summary));
    } else if (signal.type === 'run_detached') {
      this.write((current) =>
        detachAttached(current, { runId: signal.runId, surfaceId: signal.surfaceId }),
      );
    }
  }

  private write(update: (current: AttachedRuns) => AttachedRuns) {
    this.queryClient.setQueryData<AttachedRuns>(this.key(), (current) => update(current ?? []));
  }

  private key() {
    return workflowAttachedRunsQueryKey(this.runtimeIdentity);
  }
}
