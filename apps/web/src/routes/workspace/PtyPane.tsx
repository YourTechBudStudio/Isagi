import {
  Bot,
  CircleDashed,
  CirclePlus,
  PanelBottom,
  PanelRight,
  RotateCw,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import type { ReactElement } from 'react';
import { useCallback, useMemo, useRef } from 'react';

import type {
  HarnessLaunchBlockReason,
  SessionDiagnosticCode,
  SurfaceDetail,
  SurfacePane,
} from '@isagi/contracts';

import { AttentionDot } from '../../components/AttentionDot.js';
import { Button } from '../../components/Button.js';
import { ContextMenu } from '../../components/ContextMenu.js';
import { PaneActionCluster } from '../../components/PaneActionCluster.js';
import { agentSessionCopy, ptyCopy, type PaneRestorePrompt } from '../../copy/index.js';
import {
  handleDispatchedCommandError,
  useCommandDispatcher,
} from '../../lib/palette/dispatcher.js';
import { activatePane, usePaneFocusTarget } from '../../lib/workspace/activation.js';
import { attentionForPane, useAttentionStore } from '../../lib/workspace/attention.js';
import { paneHasSharedActions } from '../../lib/workspace/pane-session/presentation.js';
import { ptyPaneSession } from '../../lib/workspace/pane-session/view.js';
import {
  isDeletePending,
  paneDeleteKey,
  showsDeleteSweep,
  surfaceDeleteKey,
  useDeleteEntry,
  usePendingDeleteStore,
  useRunDelete,
} from '../../lib/workspace/pending-deletes.js';
import { paneSessionIcon } from '../../lib/workspace/surface-presentation.js';
import { BlockedPanePrompt } from './BlockedPanePrompt.js';
import { PaneTerminal } from './PaneTerminal.js';
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
  const dispatchCommand = useCommandDispatcher();
  const shellRef = useRef<HTMLElement>(null);
  const Icon = paneSessionIcon(pane.session?.kind);
  const session = useMemo(() => ptyPaneSession(pane.session), [pane.session]);
  const paneAttention = useAttentionStore((state) => attentionForPane(state.sourcesByKey, pane.id));
  const focusShell = useCallback(() => {
    shellRef.current?.focus({ preventScroll: true });
  }, []);
  const focusPane = useCallback(() => {
    activatePane({
      worktreeId: surface.worktreeId,
      surfaceId: surface.id,
      paneId: pane.id,
    });
  }, [pane.id, surface.id, surface.worktreeId]);
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
  // A delete already running against this pane — or against the surface that
  // owns it — locks every action here. The sweep is drawn once, at whichever
  // affordance started it; everything else just goes inert.
  const paneKey = paneDeleteKey(pane.id);
  const paneDelete = useDeleteEntry(paneKey);
  const surfaceDelete = useDeleteEntry(surfaceDeleteKey(surface.id));
  const actionsLocked = isDeletePending(paneDelete) || isDeletePending(surfaceDelete);
  const clearDelete = usePendingDeleteStore((state) => state.clearDelete);
  const runDelete = useRunDelete();
  const paneValues = useMemo(
    () => ({
      worktreeId: String(surface.worktreeId),
      surfaceId: String(surface.id),
      paneId: String(pane.id),
    }),
    [pane.id, surface.id, surface.worktreeId],
  );
  const dispatchPaneCommand = useCallback(
    (commandId: 'split-pane-right' | 'split-pane-down') => {
      focusPane();
      void dispatchCommand(commandId, paneValues).catch(handleDispatchedCommandError);
    },
    [dispatchCommand, focusPane, paneValues],
  );
  const deletePane = useCallback(
    (origin: 'pane' | 'menu') => {
      focusPane();
      runDelete({
        key: paneKey,
        origin,
        commandId: 'delete-active-pane',
        surfaceId: surface.id,
        values: paneValues,
      });
    },
    [focusPane, paneKey, paneValues, runDelete, surface.id],
  );
  const onSplitRight = useCallback(() => {
    dispatchPaneCommand('split-pane-right');
  }, [dispatchPaneCommand]);
  const onSplitDown = useCallback(() => {
    dispatchPaneCommand('split-pane-down');
  }, [dispatchPaneCommand]);
  const onDelete = useCallback(() => {
    deletePane('pane');
  }, [deletePane]);
  const paneMenuItems = useMemo(
    () => [
      { label: 'Split Right', icon: PanelRight, disabled: actionsLocked, onSelect: onSplitRight },
      { label: 'Split Down', icon: PanelBottom, disabled: actionsLocked, onSelect: onSplitDown },
      {
        label: 'Delete pane',
        icon: Trash2,
        danger: true,
        keepsMenuOpen: true,
        pending: showsDeleteSweep(paneDelete, 'menu'),
        disabled: actionsLocked,
        onSelect: () => deletePane('menu'),
      },
    ],
    [actionsLocked, deletePane, onSplitDown, onSplitRight, paneDelete],
  );
  const sharedPaneActions = paneHasSharedActions(view.kind);
  const onDeleteResultDismissed = useCallback(() => {
    if (paneDelete?.error) clearDelete(paneKey);
  }, [clearDelete, paneDelete, paneKey]);
  const withPaneMenu = useCallback(
    (children: ReactElement) =>
      sharedPaneActions && paneMenuItems.length > 0 ? (
        <ContextMenu
          items={paneMenuItems}
          error={paneDelete?.error ?? null}
          onResultDismissed={onDeleteResultDismissed}
        >
          {children}
        </ContextMenu>
      ) : (
        children
      ),
    [onDeleteResultDismissed, paneDelete, paneMenuItems, sharedPaneActions],
  );

  return (
    <section
      ref={shellRef}
      aria-label={pane.title}
      tabIndex={-1}
      // Promoting a pane that is being deleted would retarget Cmd+W and the
      // active-pane commands at it. The terminal keeps its own focus either way.
      onPointerDown={actionsLocked ? undefined : onFocus}
      className={`group relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-md border bg-elevated/50 backdrop-blur-sm transition-colors duration-ui ease-expo ${
        errored ? 'border-error/35' : focused ? 'border-blue/40' : 'border-line/20'
      } ${dimmed ? 'bg-elevated/38' : ''}`}
    >
      {withPaneMenu(
        <div className="flex min-h-9 items-center gap-2 border-b border-line/15 px-3 py-2">
          <Icon size={13} className="text-fg-subtle" />
          <AttentionDot state={attention} />
          <span className="truncate font-mono text-[11.5px] text-fg-muted">{pane.title}</span>
          <span className="ml-auto truncate font-mono text-[10.5px] text-fg-subtle">
            {statusLabel}
          </span>
        </div>,
      )}
      {notice ? (
        <div className="border-b border-line/12 px-3 py-1.5 font-mono text-[10.5px] text-fg-subtle">
          {notice}
        </div>
      ) : null}
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
            <UnsupportedPrompt onDelete={onDelete} disabled={actionsLocked} />
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
            onClose={onDelete}
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
      {sharedPaneActions ? (
        <PaneActionCluster
          onSplitRight={onSplitRight}
          onSplitDown={onSplitDown}
          onDelete={onDelete}
          disabled={actionsLocked}
          deletePending={showsDeleteSweep(paneDelete, 'pane')}
        />
      ) : null}
    </section>
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
  const Icon = prompt === 'resume_failed' ? TriangleAlert : CircleDashed;

  return (
    <div className="grid min-h-0 flex-1 place-items-center px-6 py-5">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <Icon
          size={18}
          aria-hidden
          className={prompt === 'resume_failed' ? 'text-error' : 'text-waiting'}
        />
        <p className="font-mono text-[12px] text-fg-muted">{agentSessionCopy.body[prompt]}</p>
        {diagnosticCode ? (
          <p className="font-mono text-[10.5px] leading-relaxed text-fg-subtle">
            <span className="text-fg-muted">{diagnosticCode}</span>
            {diagnosticDetail ? ` · ${diagnosticDetail}` : null}
          </p>
        ) : null}
        {startFreshError ? (
          <p className="font-mono text-[10.5px] leading-relaxed text-error">{startFreshError}</p>
        ) : null}
        <div className="mt-0.5 flex flex-wrap items-center justify-center gap-2">
          {onResume ? (
            <Button variant="secondary" size="sm" icon={RotateCw} onClick={onResume}>
              {prompt === 'resume_failed'
                ? agentSessionCopy.action.retry
                : agentSessionCopy.action.resume}
            </Button>
          ) : null}
          <Button
            variant={onResume ? 'ghost' : 'secondary'}
            size="sm"
            icon={CirclePlus}
            disabled={startFreshPending}
            onClick={onStartFresh}
          >
            {agentSessionCopy.action.startFresh}
          </Button>
        </div>
      </div>
    </div>
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
    <div className="grid min-h-0 flex-1 place-items-center px-6 py-5">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <RotateCw size={18} aria-hidden className="text-waiting" />
        <div className="space-y-1">
          <p className="font-mono text-[12px] text-fg-muted">{ptyCopy.movedAttachment.title}</p>
          <p className="font-mono text-[10.5px] leading-relaxed text-fg-subtle">
            {ptyCopy.movedAttachment.body}
          </p>
        </div>
        {startFreshError ? (
          <p className="font-mono text-[10.5px] leading-relaxed text-error">{startFreshError}</p>
        ) : null}
        <div className="mt-0.5 flex flex-wrap items-center justify-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            icon={CirclePlus}
            disabled={pending}
            onClick={onStartFresh}
          >
            {ptyCopy.movedAttachment.action.startFresh}
          </Button>
          <Button variant="ghost" size="sm" icon={RotateCw} disabled={pending} onClick={onReclaim}>
            {ptyCopy.movedAttachment.action.claim}
          </Button>
        </div>
      </div>
    </div>
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
