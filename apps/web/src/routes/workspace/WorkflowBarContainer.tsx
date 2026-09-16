import { AnimatePresence } from 'motion/react';
import { useMemo, useState } from 'react';

import { workflowCopy } from '../../copy/index.js';
import { useWorkspace } from '../../lib/workspace/hooks.js';
import { formatRuntimeErrorSummary } from '../../lib/workspace/runtime-data.js';
import {
  useAdvanceWorkflowMutation,
  useAttachedWorkflowRun,
  useCancelWorkflowMutation,
  useDismissWorkflowMutation,
  usePauseWorkflowMutation,
  useResumeWorkflowMutation,
  useRetryWorkflowMutation,
  useRuntimeConnectionPhase,
  useRuntimeIdentity,
  useWorkflowLog,
} from '../../lib/workspace/workflow/queries.js';
import { WorkflowBar } from './WorkflowBar.js';
import type { WorkflowInputAnswers } from './WorkflowInputFlow.js';

export function WorkflowBarContainer() {
  const { activeSurface } = useWorkspace();
  const summary = useAttachedWorkflowRun(activeSurface?.id ?? null) ?? null;
  const runId = summary?.runId ?? null;
  const runtimeIdentity = useRuntimeIdentity();
  const [logExpanded, setLogExpanded] = useState(false);
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

  const pause = usePauseWorkflowMutation(runId);
  const resume = useResumeWorkflowMutation(runId);
  const retry = useRetryWorkflowMutation(runId);
  const cancel = useCancelWorkflowMutation(runId);
  const dismiss = useDismissWorkflowMutation(runId);
  const advance = useAdvanceWorkflowMutation();

  /**
   * One control at a time.
   *
   * These are run-level controls and issuing two at once means nothing: the runtime fences them on
   * control revision, so the second is refused anyway. Leaving the others enabled let a fast Cancel
   * clear the indicator while a Pause was still in flight, and every button then looked idle while
   * work was outstanding. Locking the cluster is the honest reading of "Isagi is doing what you
   * asked", and it removes the overlap rather than trying to represent it.
   */
  const mutating =
    pause.isPending ||
    resume.isPending ||
    retry.isPending ||
    cancel.isPending ||
    dismiss.isPending ||
    advance.isPending;

  const actions = useMemo(
    () => ({
      pause: () => runAction(workflowCopy.pauseActionFailed, () => pause.mutateAsync()),
      resume: () => runAction(workflowCopy.resumeActionFailed, () => resume.mutateAsync()),
      retry: () => runAction(workflowCopy.retryActionFailed, () => retry.mutateAsync()),
      cancel: () => runAction(workflowCopy.cancelActionFailed, () => cancel.mutateAsync()),
      // A separate control and a separate failure line. Cancel stops work; Dismiss lets go of the
      // surface. Sharing either would put one action's outcome under the other's name.
      dismiss: () => runAction(workflowCopy.dismissActionFailed, () => dismiss.mutateAsync()),
      advance: (waitId: number, answers?: WorkflowInputAnswers) => {
        if (runId === null) return;
        return runAction(workflowCopy.advanceActionFailed, () =>
          advance.mutateAsync({ runId, waitId, answers }),
        );
      },
    }),
    [advance, cancel, dismiss, pause, resume, retry, runId],
  );

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

  return (
    <AnimatePresence initial={false}>
      {summary && (
        <WorkflowBar
          // One bar node, deliberately not keyed by run. Keying it left the previous run's bar
          // mounted, visible and clickable for the length of its exit animation while the next run's
          // bar was already up — two "Workflow" regions, and controls that would act on a run that
          // had just let go of the surface. The per-run state that must reset does so on `runId`.
          key="workflow-bar"
          summary={summary}
          log={log}
          connection={connection}
          logExpanded={logExpanded}
          actionsLocked={mutating}
          actionError={visible?.error ?? null}
          onToggleLog={() => setLogExpanded((expanded) => !expanded)}
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
