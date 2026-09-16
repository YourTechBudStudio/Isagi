import type { WorkflowRunSummary, WorkflowRunTransitionDelta } from '@isagi/contracts';

/**
 * What the shared runtime connection tells the workflow layer.
 *
 * One bus rather than a socket per consumer: the per-run websocket is gone, and the attached-run
 * bookkeeping, the bar's log window and the full synchronization coordinator all listen to the same
 * committed facts. `connected`/`disconnected` are facts too — a gap is only recoverable if someone
 * is told the link dropped.
 */
export type WorkflowSignal =
  | { readonly type: 'connected' }
  | { readonly type: 'disconnected' }
  | { readonly type: 'snapshot'; readonly summaries: readonly WorkflowRunSummary[] }
  | { readonly type: 'run_changed'; readonly summary: WorkflowRunSummary }
  | {
      readonly type: 'run_detached';
      readonly runId: number;
      readonly surfaceId: number | null;
    }
  | { readonly type: 'transition'; readonly delta: WorkflowRunTransitionDelta }
  /**
   * A consumer saw evidence that its view of a run is behind — a current-pin read that came back
   * naming a pin the cache does not know about, say. It asks the run's coordinator to recover
   * rather than recovering itself, so recovery keeps exactly one owner and stays serialized.
   */
  | { readonly type: 'recovery_requested'; readonly runId: number };

type Listener = (signal: WorkflowSignal) => void;

export type RuntimeConnectionPhase = 'connecting' | 'connected' | 'disconnected';

const listeners = new Set<Listener>();

/**
 * The connection's current phase, not just its transitions.
 *
 * A subscriber that only learns from future signals starts at `connecting` forever if it mounts
 * after the socket opened — which is ordinary, since the bar unmounts and remounts with zen mode.
 * Keeping the value here makes the phase replayable to whoever asks next.
 */
let connectionPhase: RuntimeConnectionPhase = 'connecting';

export function currentConnectionPhase(): RuntimeConnectionPhase {
  return connectionPhase;
}

export function subscribeToWorkflowSignals(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Asks the run's coordinator for a narrow recovery pass. A no-op when nothing is synchronizing it. */
export function requestRunRecovery(runId: number) {
  publishWorkflowSignal({ type: 'recovery_requested', runId });
}

export function publishWorkflowSignal(signal: WorkflowSignal) {
  if (signal.type === 'connected') connectionPhase = 'connected';
  else if (signal.type === 'disconnected') connectionPhase = 'disconnected';
  // Copied before iterating: a listener may unsubscribe itself while handling a signal, which is
  // ordinary for a coordinator that finishes on a terminal transition.
  for (const listener of [...listeners]) listener(signal);
}
