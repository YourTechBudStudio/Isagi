import { useAtomValue } from '@effect/atom-react';
import { Bot, CircleDashed, CirclePlus, Mic, RotateCw, TriangleAlert } from 'lucide-react';
import { useCallback, useMemo, useRef } from 'react';

import type {
  HarnessLaunchBlockReason,
  SessionDiagnosticCode,
  SurfaceDetail,
  SurfacePane,
} from '@isagi/contracts';

import { Button } from '../../components/Button.js';
import { PaneActionCluster } from '../../components/PaneActionCluster.js';
import {
  agentSessionCopy,
  fluidcastCopy,
  ptyCopy,
  type PaneRestorePrompt,
} from '../../copy/index.js';
import { useInteractionSwitchPending } from '../../lib/fluidcast/commits.js';
import { usePaneFocusTarget } from '../../lib/workspace/activation.js';
import { attentionForPane, attentionSourcesAtom } from '../../lib/workspace/attention.js';
import { paneHasSharedActions } from '../../lib/workspace/pane-session/presentation.js';
import { ptyPaneSession } from '../../lib/workspace/pane-session/view.js';
import { paneSessionIcon } from '../../lib/workspace/surface-presentation.js';
import { BlockedPanePrompt } from './BlockedPanePrompt.js';
import { PaneFrame } from './PaneFrame.js';
import { PanePrompt } from './PanePrompt.js';
import { PaneTerminal } from './PaneTerminal.js';
import { usePaneChromeActions } from './usePaneChromeActions.js';
import { usePaneMenu } from './usePaneMenu.js';
import { usePaneSession } from './usePaneSession.js';

export function PtyPane({
  pane,
  surface,
  focused,
  onFocus,
}: {
  readonly pane: SurfacePane;
  readonly surface: SurfaceDetail;
  readonly focused: boolean;
  readonly onFocus: () => void;
}) {
  const shellRef = useRef<HTMLElement>(null);
  const Icon = paneSessionIcon(pane.session?.kind);
  const session = useMemo(() => ptyPaneSession(pane.session), [pane.session]);
  const selectPaneAttention = useCallback(
    (sourcesByKey: Parameters<typeof attentionForPane>[0]) =>
      attentionForPane(sourcesByKey, pane.id),
    [pane.id],
  );
  const paneAttention = useAtomValue(attentionSourcesAtom, selectPaneAttention);
  const focusShell = useCallback(() => {
    shellRef.current?.focus({ preventScroll: true });
  }, []);
  const chrome = usePaneChromeActions({
    worktreeId: surface.worktreeId,
    surfaceId: surface.id,
    paneId: pane.id,
  });
  usePaneFocusTarget({
    surfaceId: surface.id,
    paneId: pane.id,
    priority: 0,
    focus: focusShell,
  });
  const {
    view,
    attention,
    statusLabel,
    notice,
    errored,
    dimmed,
    presentation,
    sealed,
    presentationFailure,
    restoreFailure,
    attach,
    startFresh,
    startFreshPending,
    startFreshError,
    checkAgain,
    checking,
  } = usePaneSession({
    session,
    worktreeId: surface.worktreeId,
    surfaceId: surface.id,
    paneId: pane.id,
    paneAttention,
    autoAttach: focused,
  });
  const { locked: actionsLocked, onSplitRight, onSplitDown, onDelete } = chrome;
  const sharedPaneActions = paneHasSharedActions(view.kind);
  const withPaneMenu = usePaneMenu(chrome, sharedPaneActions);
  const switchPending = useInteractionSwitchPending(pane.id);
  // Offered only where a switch can start: a terminal-mode agent the runtime reports Fluidcast
  // available for. The runtime still decides at the switch.
  const canSwitchToFluidcast =
    session?.kind === 'agent_session' &&
    session.interaction.mode === 'terminal' &&
    session.interaction.fluidcast === 'available';

  return (
    <PaneFrame
      sectionRef={shellRef}
      title={pane.title}
      icon={Icon}
      attention={attention}
      statusLabel={statusLabel}
      notice={notice}
      focused={focused}
      errored={errored}
      dimmed={dimmed}
      locked={actionsLocked}
      onFocus={onFocus}
      withPaneMenu={withPaneMenu}
      cluster={
        sharedPaneActions ? (
          <PaneActionCluster
            leadingAction={
              canSwitchToFluidcast
                ? {
                    label: fluidcastCopy.toggle.toFluidcast,
                    icon: <Mic size={13} />,
                    pressed: false,
                    pending: switchPending,
                    onClick: chrome.onToggleInteraction,
                  }
                : undefined
            }
            onSplitRight={onSplitRight}
            onSplitDown={onSplitDown}
            onDelete={() => onDelete('pane')}
            disabled={actionsLocked}
            deletePending={chrome.clusterDeletePending}
          />
        ) : null
      }
    >
      {sealed && presentation && !restoreFailure ? (
        <div className="relative flex min-h-0 flex-1">
          <PaneTerminal
            surfaceId={surface.id}
            paneId={pane.id}
            focused={focused}
            presentation={presentation}
          />
          <div className="absolute right-3 bottom-3 rounded-md border border-line/20 bg-elevated/90 p-1 shadow-soft backdrop-blur-sm">
            <Button
              size="sm"
              variant="ghost"
              onClick={view.kind === 'needs_fresh' ? startFresh : attach}
              disabled={startFreshPending}
            >
              <RotateCw size={13} />
              {view.kind === 'needs_fresh' ? ptyCopy.sealed.startFresh : ptyCopy.sealed.reconnect}
            </Button>
          </div>
        </div>
      ) : view.kind === 'unsupported' ? (
        withPaneMenu(
          <div className="flex min-h-0 flex-1">
            <UnsupportedPrompt onDelete={() => onDelete('pane')} disabled={actionsLocked} />
          </div>,
        )
      ) : view.kind === 'moved' ? (
        withPaneMenu(
          <div className="flex min-h-0 flex-1">
            <MovedPrompt
              onReclaim={attach}
              onStartFresh={startFresh}
              pending={startFreshPending}
              startFreshError={startFreshError}
            />
          </div>,
        )
      ) : view.kind === 'attachable' ? (
        withPaneMenu(
          <div className="flex min-h-0 flex-1">
            <RestorePrompt
              prompt={view.resumeFailed ? 'resume_failed' : 'resume_available'}
              diagnosticCode={session?.diagnosticCode ?? null}
              diagnosticDetail={session?.diagnosticDetail ?? null}
              onResume={attach}
              onStartFresh={startFresh}
              startFreshPending={startFreshPending}
              startFreshError={startFreshError}
            />
          </div>,
        )
      ) : view.kind === 'needs_fresh' ? (
        withPaneMenu(
          <div className="flex min-h-0 flex-1">
            <RestorePrompt
              prompt="start_fresh"
              diagnosticCode={session?.diagnosticCode ?? null}
              diagnosticDetail={session?.diagnosticDetail ?? null}
              onResume={null}
              onStartFresh={startFresh}
              startFreshPending={startFreshPending}
              startFreshError={startFreshError}
            />
          </div>,
        )
      ) : view.kind === 'blocked' ? (
        <div className="flex min-h-0 flex-1">
          <BlockedPanePrompt
            harness={session?.kind === 'agent_session' ? session.harness : null}
            reason={view.reason}
            onClose={() => onDelete('pane')}
            deletePending={actionsLocked}
          />
        </div>
      ) : view.kind === 'unavailable' ? (
        withPaneMenu(
          <div className="flex min-h-0 flex-1">
            <UnavailablePrompt reason={view.reason} onCheckAgain={checkAgain} checking={checking} />
          </div>,
        )
      ) : presentationFailure ? (
        withPaneMenu(
          <div className="flex min-h-0 flex-1">
            <TerminalRecoveryPrompt
              copy={ptyCopy.presentationFailed}
              detail={presentationFailure.detail}
              onRetry={attach}
            />
          </div>,
        )
      ) : restoreFailure ? (
        withPaneMenu(
          <div className="flex min-h-0 flex-1">
            <TerminalRecoveryPrompt
              copy={ptyCopy.restoreIncomplete}
              detail={restoreFailure.detail}
              onRetry={attach}
            />
          </div>,
        )
      ) : view.kind === 'live' && session && presentation ? (
        <PaneTerminal
          surfaceId={surface.id}
          paneId={pane.id}
          focused={focused}
          presentation={presentation}
        />
      ) : (
        withPaneMenu(
          <div className="grid min-h-0 flex-1 place-items-center px-4">
            <span className="font-mono text-[12px] text-fg-subtle">{ptyCopy.emptyPane}</span>
          </div>,
        )
      )}
    </PaneFrame>
  );
}

function RestorePrompt({
  prompt,
  diagnosticCode,
  diagnosticDetail,
  onResume,
  onStartFresh,
  startFreshPending,
  startFreshError,
}: {
  readonly prompt: PaneRestorePrompt;
  readonly diagnosticCode: SessionDiagnosticCode | null;
  readonly diagnosticDetail: string | null;
  readonly onResume: (() => void) | null;
  readonly onStartFresh: () => void;
  readonly startFreshPending: boolean;
  readonly startFreshError: string | null;
}) {
  const failed = prompt === 'resume_failed';
  const startFreshAction = {
    label: agentSessionCopy.action.startFresh,
    icon: CirclePlus,
    variant: onResume ? 'ghost' : 'secondary',
    disabled: startFreshPending,
    onClick: onStartFresh,
  } as const;

  return (
    <PanePrompt
      icon={failed ? TriangleAlert : CircleDashed}
      iconClassName={failed ? 'text-error' : 'text-waiting'}
      body={agentSessionCopy.body[prompt]}
      diagnostic={diagnosticCode ? { code: diagnosticCode, detail: diagnosticDetail } : null}
      error={startFreshError}
      actions={
        onResume
          ? [
              {
                label: failed ? agentSessionCopy.action.retry : agentSessionCopy.action.resume,
                icon: RotateCw,
                variant: 'secondary',
                onClick: onResume,
              },
              startFreshAction,
            ]
          : [startFreshAction]
      }
    />
  );
}

// The session is alive but its terminal never got built, or never finished
// restoring. Retry rebuilds the presentation against the same session; "start
// fresh" is deliberately absent, since throwing away a live session over a
// renderer or replay failure is not a recovery.
function TerminalRecoveryPrompt({
  copy,
  detail,
  onRetry,
}: {
  readonly copy: { readonly title: string; readonly body: string; readonly action: string };
  readonly detail: string | null;
  readonly onRetry: () => void;
}) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center px-6 py-5">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <TriangleAlert size={18} aria-hidden className="text-error" />
        <div className="space-y-1">
          <p className="font-mono text-[12px] text-fg-muted">{copy.title}</p>
          <p className="font-mono text-[10.5px] leading-relaxed text-fg-subtle">{copy.body}</p>
        </div>
        {detail ? (
          <p className="font-mono text-[10.5px] leading-relaxed break-all text-fg-subtle">
            {detail}
          </p>
        ) : null}
        <Button variant="secondary" size="sm" icon={RotateCw} onClick={onRetry}>
          {copy.action}
        </Button>
      </div>
    </div>
  );
}

function UnsupportedPrompt({
  onDelete,
  disabled,
}: {
  readonly onDelete: () => void;
  readonly disabled: boolean;
}) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center px-6 py-5">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <Bot size={18} aria-hidden className="text-fg-subtle" />
        <div className="space-y-1">
          <p className="font-mono text-[12px] text-fg-muted">{ptyCopy.unsupportedHarness.title}</p>
          <p className="font-mono text-[10.5px] leading-relaxed text-fg-subtle">
            {ptyCopy.unsupportedHarness.body}
          </p>
        </div>
        {/* The pinned action cluster carries the running indicator for this pane. */}
        <Button variant="danger" size="sm" disabled={disabled} onClick={onDelete}>
          {ptyCopy.unsupportedHarness.action}
        </Button>
      </div>
    </div>
  );
}

function MovedPrompt({
  onReclaim,
  onStartFresh,
  pending,
  startFreshError,
}: {
  readonly onReclaim: () => void;
  readonly onStartFresh: () => void;
  readonly pending: boolean;
  readonly startFreshError: string | null;
}) {
  return (
    <PanePrompt
      icon={RotateCw}
      iconClassName="text-waiting"
      title={ptyCopy.movedAttachment.title}
      body={ptyCopy.movedAttachment.body}
      error={startFreshError}
      actions={[
        {
          label: ptyCopy.movedAttachment.action.startFresh,
          icon: CirclePlus,
          variant: 'secondary',
          disabled: pending,
          onClick: onStartFresh,
        },
        {
          label: ptyCopy.movedAttachment.action.claim,
          icon: RotateCw,
          variant: 'ghost',
          disabled: pending,
          onClick: onReclaim,
        },
      ]}
    />
  );
}

// A durable agent pane whose harness is unavailable (or still being probed). The
// pane is retained; "Check again" refreshes host facts before re-evaluating.
function UnavailablePrompt({
  reason,
  checking,
  onCheckAgain,
}: {
  readonly reason: HarnessLaunchBlockReason;
  readonly checking: boolean;
  readonly onCheckAgain: () => void;
}) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center px-6 py-5">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <CircleDashed size={18} aria-hidden className="text-fg-subtle" />
        <div className="space-y-1">
          <p className="font-mono text-[12px] text-fg-muted">
            {agentSessionCopy.launchBlock.status[reason]}
          </p>
          <p className="font-mono text-[10.5px] leading-relaxed text-fg-subtle">
            {agentSessionCopy.launchBlock.body[reason]}
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          icon={RotateCw}
          disabled={checking}
          onClick={onCheckAgain}
        >
          {checking
            ? agentSessionCopy.launchBlock.checking
            : agentSessionCopy.launchBlock.checkAgain}
        </Button>
      </div>
    </div>
  );
}
