import type { WorkflowEventDto, WorkflowRunSummary } from '@isagi/contracts';

/**
 * What the shared runtime connection tells the workflow layer.
 *
 * One bus rather than a socket per consumer: the attached-run list and every open run view listen to
 * the same pushed facts. `connected`/`disconnected` are facts too, because a client that was offline
 * has to refetch what it missed.
 */
export type WorkflowSignal =
  | { readonly type: 'connected' }
  | { readonly type: 'disconnected' }
  | { readonly type: 'snapshot'; readonly summaries: readonly WorkflowRunSummary[] }
  | { readonly type: 'run_changed'; readonly summary: WorkflowRunSummary }
  | { readonly type: 'run_event'; readonly event: WorkflowEventDto };

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

export function publishWorkflowSignal(signal: WorkflowSignal) {
  if (signal.type === 'connected') connectionPhase = 'connected';
  else if (signal.type === 'disconnected') connectionPhase = 'disconnected';
  // Copied before iterating: a listener may unsubscribe itself while handling a signal.
  for (const listener of [...listeners]) listener(signal);
}
