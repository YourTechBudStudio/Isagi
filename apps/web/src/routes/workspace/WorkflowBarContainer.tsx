import { useAtom } from '@effect/atom-react';
import { AnimatePresence } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { workflowCopy } from '../../copy/index.js';
import { useWorkspace } from '../../lib/workspace/hooks.js';
import { formatRuntimeErrorSummary } from '../../lib/workspace/runtime-data.js';
import {
  useAttachedWorkflowRun,
  useRuntimeConnectionPhase,
  useRuntimeIdentity,
  useWorkflowLog,
  workflowControlAtoms,
} from '../../lib/workspace/workflow/queries.js';
import type { LayoutEngineFactory } from './workflow/useGraphLayout.js';
import { WorkflowInspector } from './workflow/WorkflowInspector.js';
import { WorkflowBar } from './WorkflowBar.js';
import type { WorkflowInputAnswers } from './WorkflowInputFlow.js';

export function WorkflowBarContainer({
  inspectorEngineFactory,
}: {
  /**
   * A layout engine for the inspector, for the maintained browser fixture only.
   *
   * The stale-response, first-failure and cleanup rules live in a mounted hook, so testing them at
   * all means being able to script what the engine does. Production passes nothing and gets the real
   * ELK engine; there is no other caller and no other way in.
   */
  readonly inspectorEngineFactory?: LayoutEngineFactory | undefined;
} = {}) {
  const { activeSurface } = useWorkspace();
  const summary = useAttachedWorkflowRun(activeSurface?.id ?? null) ?? null;
  const runId = summary?.runId ?? null;
  const runtimeIdentity = useRuntimeIdentity();
  const [logExpanded, setLogExpanded] = useState(false);
  /**
   * Local, and deliberately not a route.
   *
   * The inspector opens from the bar of the surface its run is attached to and nowhere else: there
   * is no `/workspace/workflows/:runId`, no direct-by-run-id entry, and no promise that a link stays
   * valid after Dismiss. Keeping it beside `logExpanded` is what makes that true by construction.
   */
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [barHeight, setBarHeight] = useState(64);
  const barRef = useRef<HTMLElement | null>(null);
  const connection = useRuntimeConnectionPhase();
  // The window is read only while the panel is open, and it never establishes delta coverage — the
  // full per-run coordinator is a separate, inspector-driven concern.
  const log = useWorkflowLog(summary, { enabled: logExpanded });

  /**
   * The action in flight and what it reported, stamped with the run and runtime it belongs to.
   *
   * Scoped rather than reset by an effect: an effect clears it a render too late, so a settled
   * failure from one run could be drawn once against the run that replaced it. Filtering during
   * render means feedback for a run nobody is looking at is simply never shown.
   */
  const [feedback, setFeedback] = useState<{
    readonly scope: string;
    readonly error: string | null;
  } | null>(null);
  const scope = `${runtimeIdentity ?? ''}:${runId ?? ''}`;
  const visible = feedback?.scope === scope ? feedback : null;

  // The controls belong to the run they act on: a new run gets fresh pending/error state, while a
  // control already sent for the previous run still completes (writes are uninterruptible).
  const controls = useMemo(() => workflowControlAtoms(runId), [runId]);
  const [pauseState, pause] = useAtom(controls.pause, { mode: 'promise' });
  const [resumeState, resume] = useAtom(controls.resume, { mode: 'promise' });
  const [retryState, retry] = useAtom(controls.retry, { mode: 'promise' });
  const [cancelState, cancel] = useAtom(controls.cancel, { mode: 'promise' });
  const [dismissState, dismiss] = useAtom(controls.dismiss, { mode: 'promise' });
  const [advanceState, advance] = useAtom(controls.advance, { mode: 'promise' });

  /**
   * One control at a time.
   *
   * These are run-level controls and issuing two at once means nothing. Leaving the others enabled let a fast Cancel
   * clear the indicator while a Pause was still in flight, and every button then looked idle while
   * work was outstanding. Locking the cluster is the honest reading of "Isagi is doing what you
   * asked", and it removes the overlap rather than trying to represent it.
   */
  const mutating =
    pauseState.waiting ||
    resumeState.waiting ||
    retryState.waiting ||
    cancelState.waiting ||
    dismissState.waiting ||
    advanceState.waiting;

  const actions = useMemo(
    () => ({
      pause: () => runAction(workflowCopy.pauseActionFailed, () => pause()),
      resume: () => runAction(workflowCopy.resumeActionFailed, () => resume()),
      retry: () => runAction(workflowCopy.retryActionFailed, () => retry()),
      cancel: () => runAction(workflowCopy.cancelActionFailed, () => cancel()),
      // A separate control and a separate failure line. Cancel stops work; Dismiss lets go of the
      // surface. Sharing either would put one action's outcome under the other's name.
      dismiss: () => runAction(workflowCopy.dismissActionFailed, () => dismiss()),
      advance: (executionId: number, answers?: WorkflowInputAnswers) => {
        if (runId === null) return;
        return runAction(workflowCopy.advanceActionFailed, () => advance({ executionId, answers }));
      },
    }),
    // `runAction` reads `mutating` and `scope`; the setters themselves are stable per run.
    [advance, cancel, dismiss, pause, resume, retry, runId, mutating, scope],
  );

  /**
   * Tracks how tall the bar is, so the overlay can stop above it.
   *
   * A callback ref rather than an effect on a stable ref: the bar unmounts and remounts with the
   * run, and the observer has to follow the element that actually exists.
   */
  const setBarElement = useCallback((element: HTMLElement | null) => {
    barRef.current = element;
    if (element) setBarHeight(element.offsetHeight);
  }, []);

  useEffect(() => {
    const element = barRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setBarHeight(element.offsetHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, [summary?.runId, logExpanded, inspectorOpen]);

  async function runAction(fallback: string, fn: () => Promise<unknown>) {
    // Refused rather than queued. The cluster is locked while anything is pending, so this only
    // catches a race between the click and the re-render.
    if (mutating) return;
    setFeedback({ scope, error: null });
    try {
      await fn();
      // Deliberately nothing else. The runtime publishes what actually happened; writing an
      // outcome here would be the client claiming a control succeeded on the runtime's behalf.
      setFeedback((current) => (current?.scope === scope ? { scope, error: null } : current));
    } catch (error) {
      // `fallback` is the web-owned action context ("Couldn't pause the workflow."); the reason is
      // mapped from the runtime's stable code via the shared copy registry — never its raw message.
      // Only recorded against the run it was issued for: a reply that crosses a run swap describes
      // something nobody is looking at.
      setFeedback((current) =>
        current?.scope === scope
          ? { scope, error: `${fallback} ${formatRuntimeErrorSummary(error)}` }
          : current,
      );
    }
  }

  // A run that let go of this surface takes its inspector with it: an overlay left open would be
  // describing a run the bar no longer shows.
  if (summary === null && inspectorOpen) setInspectorOpen(false);

  return (
    <AnimatePresence initial={false}>
      {summary && inspectorOpen && (
        <WorkflowInspector
          key={`workflow-inspector-${summary.runId}`}
          summary={summary}
          bottomInset={barHeight}
          engineFactory={inspectorEngineFactory}
          onClose={() => setInspectorOpen(false)}
        />
      )}
      {summary && (
        <WorkflowBar
          // One bar node, deliberately not keyed by run. Keying it left the previous run's bar
          // mounted, visible and clickable for the length of its exit animation while the next run's
          // bar was already up — two "Workflow" regions, and controls that would act on a run that
          // had just let go of the surface. The per-run state that must reset does so on `runId`.
          key="workflow-bar"
          sectionRef={setBarElement}
          summary={summary}
          log={log}
          connection={connection}
          logExpanded={logExpanded}
          inspectorOpen={inspectorOpen}
          actionsLocked={mutating}
          actionError={visible?.error ?? null}
          onToggleLog={() => setLogExpanded((expanded) => !expanded)}
          onToggleInspector={() => setInspectorOpen((open) => !open)}
          onPause={actions.pause}
          onResume={actions.resume}
          onCancel={actions.cancel}
          onRetry={actions.retry}
          onDismiss={actions.dismiss}
          onAdvance={actions.advance}
        />
      )}
    </AnimatePresence>
  );
}
