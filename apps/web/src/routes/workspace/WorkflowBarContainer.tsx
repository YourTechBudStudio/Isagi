import { AnimatePresence } from 'motion/react';
import { useMemo, useState } from 'react';

import { workflowCopy } from '../../copy/index.js';
import { useWorkspace } from '../../lib/workspace/hooks.js';
import {
  useAdvanceWorkflowMutation,
  useClearWorkflowMutation,
  usePauseWorkflowMutation,
  useRetryWorkflowMutation,
  useResumeWorkflowMutation,
} from '../../lib/workspace/queries.js';
import { formatRuntimeErrorSummary } from '../../lib/workspace/runtime-data.js';
import { useWorkflowEventStream } from '../../lib/workspace/workflow-events/stream.js';
import { selectRootRunForSurface, useWorkflowRunStore } from '../../lib/workspace/workflow-runs.js';
import { WorkflowBar, type WorkflowBarAction } from './WorkflowBar.js';
import type { WorkflowInputAnswers } from './WorkflowInputFlow.js';

export function WorkflowBarContainer() {
  const { activeSurface } = useWorkspace();
  const surfaceId = activeSurface?.id ?? null;
  const summary = useWorkflowRunStore(selectRootRunForSurface(surfaceId));
  const [logExpanded, setLogExpanded] = useState(false);
  const [busyAction, setBusyAction] = useState<WorkflowBarAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const eventStream = useWorkflowEventStream({
    runId: summary?.rootRunId ?? null,
    includeChildren: true,
    enabled: Boolean(summary) && logExpanded,
  });

  const pause = usePauseWorkflowMutation(summary?.rootRunId ?? null);
  const resume = useResumeWorkflowMutation(summary?.rootRunId ?? null);
  const clear = useClearWorkflowMutation(summary?.rootRunId ?? null);
  const retry = useRetryWorkflowMutation(summary?.rootRunId ?? null);
  const advance = useAdvanceWorkflowMutation();

  const mutating =
    pause.isPending || resume.isPending || clear.isPending || retry.isPending || advance.isPending;
  const visibleBusyAction = mutating ? busyAction : null;

  const actions = useMemo(
    () => ({
      pause: () => runAction('pause', workflowCopy.pauseActionFailed, () => pause.mutateAsync()),
      resume: () =>
        runAction('resume', workflowCopy.resumeActionFailed, () => resume.mutateAsync()),
      cancel: () => runAction('cancel', workflowCopy.clearActionFailed, () => clear.mutateAsync()),
      dismiss: () =>
        runAction('dismiss', workflowCopy.clearActionFailed, () => clear.mutateAsync()),
      retry: () => runAction('retry', workflowCopy.retryActionFailed, () => retry.mutateAsync()),
      advance: (runId: number, answers?: WorkflowInputAnswers) =>
        runAction('advance', workflowCopy.advanceActionFailed, () =>
          advance.mutateAsync({ runId, answers }),
        ),
    }),
    [advance, clear, pause, resume, retry],
  );

  async function runAction(
    action: WorkflowBarAction,
    fallback: string,
    fn: () => Promise<unknown>,
  ) {
    setActionError(null);
    setBusyAction(action);
    try {
      await fn();
    } catch (error) {
      // `fallback` is the web-owned action context ("Couldn't pause the workflow.");
      // the reason is mapped from the runtime's stable code/reason via the shared
      // copy registry — never the raw runtime/step message.
      setActionError(`${fallback} ${formatRuntimeErrorSummary(error)}`);
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <AnimatePresence initial={false}>
      {summary && (
        <WorkflowBar
          key={summary.runId}
          summary={summary}
          events={eventStream.events}
          eventConnection={eventStream.connection}
          logExpanded={logExpanded}
          busyAction={visibleBusyAction}
          actionError={actionError}
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
