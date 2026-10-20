import { useAtomValue } from '@effect/atom-react';
import { Mic, SquareTerminal, TriangleAlert } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';

import type {
  AgentSessionInteractionMode,
  AgentSessionMetadata,
  FluidcastHandoffFailure,
  SurfaceDetail,
  SurfacePane,
} from '@isagi/contracts';

import { PaneActionCluster } from '../../components/PaneActionCluster.js';
import { fluidcastCopy } from '../../copy/index.js';
import {
  interactionOrigin,
  isHandoffFailure,
  setPaneInteraction,
  useInteractionSwitchPending,
} from '../../lib/fluidcast/commits.js';
import { useAppRun } from '../../lib/state/registry.js';
import { usePaneFocusTarget } from '../../lib/workspace/activation.js';
import { attentionForPane, attentionSourcesAtom } from '../../lib/workspace/attention.js';
import { formatRuntimeError } from '../../lib/workspace/runtime-data.js';
import { paneSessionIcon } from '../../lib/workspace/surface-presentation.js';
import { PaneFrame } from './PaneFrame.js';
import { PanePrompt } from './PanePrompt.js';
import { usePaneChromeActions } from './usePaneChromeActions.js';
import { usePaneMenu } from './usePaneMenu.js';

export type FluidcastFailedAgentSession = AgentSessionMetadata & {
  readonly interaction: {
    readonly mode: 'fluidcast_failed';
    readonly generation: number;
    readonly failure: FluidcastHandoffFailure;
  };
};

/**
 * An agent pane whose switch to Fluidcast began cleanup but left no Fluidcast session running. It
 * never mounts a terminal, so nothing attaches behind the failure. Retry and Back to terminal act
 * on the failure shown here: each sends this projection as the switch's `from`, so a change the
 * pane has not re-read yet is refused instead of acted on. The pane offers no toggle, since its own
 * buttons already go both ways.
 */
export function FluidcastFailurePane({
  pane,
  surface,
  agentSession,
  focused,
  onFocus,
}: {
  readonly pane: SurfacePane;
  readonly surface: SurfaceDetail;
  readonly agentSession: FluidcastFailedAgentSession;
  readonly focused: boolean;
  readonly onFocus: () => void;
}) {
  const shellRef = useRef<HTMLElement>(null);
  const run = useAppRun();
  const chrome = usePaneChromeActions({
    worktreeId: surface.worktreeId,
    surfaceId: surface.id,
    paneId: pane.id,
  });
  const withPaneMenu = usePaneMenu(chrome, true);
  const switchPending = useInteractionSwitchPending(pane.id);
  const [pendingAction, setPendingAction] = useState<AgentSessionInteractionMode | null>(null);
  // A refusal belongs to the failure it was made against; once the projection moves on it is stale.
  const [refusal, setRefusal] = useState<{
    readonly generation: number;
    readonly message: string;
  } | null>(null);
  const selectPaneAttention = useCallback(
    (sourcesByKey: Parameters<typeof attentionForPane>[0]) =>
      attentionForPane(sourcesByKey, pane.id),
    [pane.id],
  );
  const attention = useAtomValue(attentionSourcesAtom, selectPaneAttention);
  const focusShell = useCallback(() => {
    shellRef.current?.focus({ preventScroll: true });
  }, []);
  usePaneFocusTarget({ surfaceId: surface.id, paneId: pane.id, priority: 0, focus: focusShell });

  const { generation, failure } = agentSession.interaction;
  const switchTo = (mode: AgentSessionInteractionMode) => {
    setPendingAction(mode);
    setRefusal(null);
    run(
      setPaneInteraction({
        surfaceId: surface.id,
        paneId: pane.id,
        agentSessionId: agentSession.id,
        mode,
        from: interactionOrigin(agentSession),
      }),
    )
      .catch((error: unknown) => {
        // A new handoff failure re-renders this panel with its own copy; anything else was refused
        // before the switch began and is shown here.
        if (!isHandoffFailure(error))
          setRefusal({ generation, message: formatRuntimeError(error) });
      })
      .finally(() => setPendingAction(null));
  };
  const inert = chrome.locked || switchPending;
  const copy = fluidcastCopy.failure.describe(failure);

  return (
    <PaneFrame
      sectionRef={shellRef}
      title={pane.title}
      icon={paneSessionIcon(pane.session?.kind)}
      attention={attention}
      statusLabel={fluidcastCopy.failure.statusLabel}
      focused={focused}
      errored
      locked={chrome.locked}
      onFocus={onFocus}
      withPaneMenu={withPaneMenu}
      cluster={
        <PaneActionCluster
          onSplitRight={chrome.onSplitRight}
          onSplitDown={chrome.onSplitDown}
          onDelete={() => chrome.onDelete('pane')}
          disabled={chrome.locked}
          deletePending={chrome.clusterDeletePending}
        />
      }
    >
      {withPaneMenu(
        <div className="flex min-h-0 flex-1">
          <PanePrompt
            icon={TriangleAlert}
            iconClassName="text-error"
            title={copy.title}
            body={copy.body}
            diagnostic={{ code: failure.code, detail: failureDetail(failure) }}
            error={refusal?.generation === generation ? refusal.message : null}
            actions={[
              {
                label: fluidcastCopy.failure.retry,
                icon: Mic,
                variant: 'secondary',
                disabled: inert,
                pending: switchPending && pendingAction === 'fluidcast',
                onClick: () => switchTo('fluidcast'),
              },
              {
                label: fluidcastCopy.failure.back,
                icon: SquareTerminal,
                variant: 'ghost',
                disabled: inert,
                pending: switchPending && pendingAction === 'terminal',
                onClick: () => switchTo('terminal'),
              },
            ]}
          />
        </div>,
      )}
    </PaneFrame>
  );
}

function failureDetail(failure: FluidcastHandoffFailure): string {
  switch (failure.code) {
    case 'fluidcast_session_unreadable':
    case 'fluidcast_start_failed':
      return failure.reason;
    case 'terminal_stop_failed':
    case 'fluidcast_preparation_failed':
      return failure.diagnostic;
  }
}
