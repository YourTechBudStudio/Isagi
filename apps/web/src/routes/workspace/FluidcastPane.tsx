import '@yourtechbudstudio/fluidcast-react/styles.css';
import { useAtomValue } from '@effect/atom-react';
import { FluidcastPlayer } from '@yourtechbudstudio/fluidcast-react';
import { Mic } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AgentSessionMetadata, SurfaceDetail, SurfacePane } from '@isagi/contracts';

import { PaneActionCluster } from '../../components/PaneActionCluster.js';
import { fluidcastCopy, ptyCopy } from '../../copy/index.js';
import { useInteractionSwitchPending } from '../../lib/fluidcast/commits.js';
import { fluidcastConnection } from '../../lib/fluidcast/connection.js';
import { fluidcastPendingPausesAtom } from '../../lib/fluidcast/pending-pauses.js';
import { runtimeUrlAtom } from '../../lib/fluidcast/runtime-url.js';
import { useRegistry } from '../../lib/state/registry.js';
import { restoreActivePaneFocus, usePaneFocusTarget } from '../../lib/workspace/activation.js';
import { attentionForPane, attentionSourcesAtom } from '../../lib/workspace/attention.js';
import { NO_EXIT } from '../../lib/workspace/pane-session/presentation.js';
import { paneSessionIcon } from '../../lib/workspace/surface-presentation.js';
import { PaneFrame } from './PaneFrame.js';
import { usePaneChromeActions } from './usePaneChromeActions.js';
import { usePaneMenu } from './usePaneMenu.js';

export type FluidcastAgentSession = AgentSessionMetadata & {
  readonly interaction: { readonly mode: 'fluidcast'; readonly fluidcastSessionId: string };
};

/**
 * An agent pane in Fluidcast mode: Isagi's pane frame around the real Fluidcast player. It never
 * mounts a terminal or attaches a PTY. The player's lifetime is the runtime's session, not this
 * component: unmounting releases only the player instance, and hiding is paused by
 * `useFluidcastPresentation`, so the player here is always `visible`.
 */
export function FluidcastPane({
  pane,
  surface,
  agentSession,
  focused,
  onFocus,
}: {
  readonly pane: SurfacePane;
  readonly surface: SurfaceDetail;
  readonly agentSession: FluidcastAgentSession;
  readonly focused: boolean;
  readonly onFocus: () => void;
}) {
  const registry = useRegistry();
  const shellRef = useRef<HTMLElement>(null);
  const [playerRoot, setPlayerRoot] = useState<HTMLDivElement | null>(null);
  const { fluidcastSessionId } = agentSession.interaction;
  const runtimeUrl = useAtomValue(runtimeUrlAtom);
  const pendingPauses = useAtomValue(fluidcastPendingPausesAtom);
  const resolvedUrl = runtimeUrl._tag === 'Success' ? runtimeUrl.value : null;
  // A new session ID is a new player instance; the same ID keeps its instance across re-renders.
  const connection = useMemo(
    () =>
      resolvedUrl === null
        ? null
        : fluidcastConnection({
            runtimeUrl: resolvedUrl,
            fluidcastSessionId,
            beforeSubscribe: pendingPauses.settled(fluidcastSessionId),
          }),
    [resolvedUrl, fluidcastSessionId, pendingPauses],
  );

  const chrome = usePaneChromeActions({
    worktreeId: surface.worktreeId,
    surfaceId: surface.id,
    paneId: pane.id,
  });
  const withPaneMenu = usePaneMenu(chrome, true);
  const switchPending = useInteractionSwitchPending(pane.id);
  const selectPaneAttention = useCallback(
    (sourcesByKey: Parameters<typeof attentionForPane>[0]) =>
      attentionForPane(sourcesByKey, pane.id),
    [pane.id],
  );
  const attention = useAtomValue(attentionSourcesAtom, selectPaneAttention);

  // Activation focuses the pane a couple of frames after the click that caused it. When focus is
  // already inside the player (the composer, a control the user just clicked), that is newer intent
  // and stays; the root is only the landing spot when focus is elsewhere.
  const focusPlayer = useCallback(() => {
    const target = playerRoot ?? shellRef.current;
    if (!target || target.contains(document.activeElement)) return;
    target.focus({ preventScroll: true });
  }, [playerRoot]);
  usePaneFocusTarget({ surfaceId: surface.id, paneId: pane.id, priority: 100, focus: focusPlayer });
  // The player root appears after the runtime URL resolves; re-assert focus once it exists, as
  // `PaneTerminal` does after its reveal. The router keeps an open palette or drawer in charge.
  useEffect(() => {
    if (focused && playerRoot) restoreActivePaneFocus(registry);
  }, [focused, playerRoot, registry]);

  const { status, statusReason } = agentSession;
  const failed = statusReason === 'agent_worker_failed';

  return (
    <PaneFrame
      sectionRef={shellRef}
      title={pane.title}
      icon={paneSessionIcon(pane.session?.kind)}
      attention={attention}
      statusLabel={ptyCopy.sessionStatus(status, statusReason, NO_EXIT)}
      notice={failed ? ptyCopy.sessionNotice(status, statusReason) : null}
      focused={focused}
      errored={failed}
      locked={chrome.locked}
      onFocus={onFocus}
      withPaneMenu={withPaneMenu}
      // The same floating, hover-revealed cluster as every other pane (the user's choice): one
      // place for split, delete and the toggle, although it overlaps the player's dock when shown.
      cluster={
        <PaneActionCluster
          leadingAction={{
            label: fluidcastCopy.toggle.toTerminal,
            icon: <Mic size={13} />,
            pressed: true,
            pending: switchPending,
            onClick: chrome.onToggleInteraction,
          }}
          onSplitRight={chrome.onSplitRight}
          onSplitDown={chrome.onSplitDown}
          onDelete={() => chrome.onDelete('pane')}
          disabled={chrome.locked}
          deletePending={chrome.clusterDeletePending}
        />
      }
    >
      <div className="relative min-h-0 flex-1">
        {connection ? (
          <div className="absolute inset-0">
            <FluidcastPlayer connection={connection} visible ref={setPlayerRoot} />
          </div>
        ) : runtimeUrl._tag === 'Failure' ? (
          <div className="grid h-full place-items-center px-6 py-5">
            <p className="max-w-sm text-center font-mono text-[12px] text-fg-muted">
              {fluidcastCopy.runtimeUnreachable}
            </p>
          </div>
        ) : null}
      </div>
    </PaneFrame>
  );
}
