import { Bot, CircleDashed, CirclePlus, RotateCw, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import type { SessionDiagnosticCode, SurfaceDetail, SurfacePane } from '@isagi/contracts';

import { AttentionDot } from '../../components/AttentionDot.js';
import { Button } from '../../components/Button.js';
import { PaneDeleteButton } from '../../components/PaneDeleteButton.js';
import { agentSessionCopy, ptyCopy, type PaneRestorePrompt } from '../../copy/index.js';
import {
  handleDispatchedCommandError,
  useCommandDispatcher,
} from '../../lib/palette/dispatcher.js';
import {
  activatePane,
  syncActivePaneFromSurfaceDetail,
  usePaneFocusTarget,
} from '../../lib/workspace/activation.js';
import { attentionForPane, useAttentionStore } from '../../lib/workspace/attention.js';
import {
  resolveActivePaneId,
  resolvePaneFocusAfterDetailChange,
} from '../../lib/workspace/model.js';
import { ptyPaneSession } from '../../lib/workspace/pane-session/view.js';
import { useWorkspaceStore } from '../../lib/workspace/store.js';
import { paneSessionIcon } from '../../lib/workspace/surface-presentation.js';
import { PaneTerminal } from './PaneTerminal.js';
import { usePaneSession } from './usePaneSession.js';

interface PtySurfaceProps {
  readonly detail: SurfaceDetail;
}

export function PtySurface({ detail }: PtySurfaceProps) {
  const storedPaneId = useWorkspaceStore((state) => state.activePaneBySurfaceId[detail.id]);
  const dispatchCommand = useCommandDispatcher();
  const focusedPaneId = resolveActivePaneId(detail.panes, storedPaneId, detail.activePaneId);
  const previousPaneIds = useRef<ReadonlySet<number> | null>(null);

  useEffect(() => {
    const nextFocusedPaneId = resolvePaneFocusAfterDetailChange({
      panes: detail.panes,
      storedPaneId,
      detailActivePaneId: detail.activePaneId,
      previousPaneIds: previousPaneIds.current,
    });
    previousPaneIds.current = new Set(detail.panes.map((pane) => pane.id));
    if (nextFocusedPaneId !== null) {
      syncActivePaneFromSurfaceDetail({
        worktreeId: detail.worktreeId,
        surfaceId: detail.id,
        panes: detail.panes,
        detailActivePaneId: detail.activePaneId,
        preferredPaneId: nextFocusedPaneId,
      });
    }
  }, [detail.id, detail.worktreeId, detail.panes, detail.activePaneId, storedPaneId]);

  if (detail.panes.length === 0) {
    return (
      <div className="grid h-full place-items-center rounded-md border border-line/20 bg-elevated/50 backdrop-blur-sm">
        <span className="font-mono text-[12px] text-fg-subtle">{ptyCopy.emptySurface}</span>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 gap-2">
      {detail.panes.map((pane) => (
        <PtyPaneShell
          key={pane.id}
          pane={pane}
          surface={detail}
          focused={pane.id === focusedPaneId}
          onFocus={() =>
            activatePane({ worktreeId: detail.worktreeId, surfaceId: detail.id, paneId: pane.id })
          }
          onDelete={() => {
            activatePane({
              worktreeId: detail.worktreeId,
              surfaceId: detail.id,
              paneId: pane.id,
            });
            void dispatchCommand('delete-active-pane', {
              worktreeId: String(detail.worktreeId),
              surfaceId: String(detail.id),
              paneId: String(pane.id),
            }).catch(handleDispatchedCommandError);
          }}
        />
      ))}
    </div>
  );
}

function PtyPaneShell({
  pane,
  surface,
  focused,
  onFocus,
  onDelete,
}: {
  readonly pane: SurfacePane;
  readonly surface: SurfaceDetail;
  readonly focused: boolean;
  readonly onFocus: () => void;
  readonly onDelete: () => void;
}) {
  const shellRef = useRef<HTMLElement>(null);
  const Icon = paneSessionIcon(pane.session?.kind);
  const session = useMemo(() => ptyPaneSession(pane.session), [pane.session]);
  const paneAttention = useAttentionStore((state) => attentionForPane(state.sourcesByKey, pane.id));
  const focusShell = useCallback(() => {
    shellRef.current?.focus({ preventScroll: true });
  }, []);
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
    transport,
    terminalKey,
    onRendererWarning,
    attach,
    startFresh,
    startFreshPending,
    startFreshError,
  } = usePaneSession({
    session,
    worktreeId: surface.worktreeId,
    surfaceId: surface.id,
    paneId: pane.id,
    paneAttention,
    autoAttach: focused,
  });

  return (
    <section
      ref={shellRef}
      aria-label={pane.title}
      tabIndex={-1}
      onPointerDown={onFocus}
      className={`group relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-md border bg-elevated/50 backdrop-blur-sm transition-opacity duration-ui ease-expo ${
        focused ? 'opacity-100' : 'opacity-55'
      } ${errored ? 'border-error/35' : focused ? 'border-blue/40' : 'border-line/20'} ${
        dimmed ? 'bg-elevated/38' : ''
      }`}
    >
      <div className="flex min-h-9 items-center gap-2 border-b border-line/15 px-3 py-2">
        <Icon size={13} className="text-fg-subtle" />
        <AttentionDot state={attention} />
        <span className="truncate font-mono text-[11.5px] text-fg-muted">{pane.title}</span>
        <span className="ml-auto truncate font-mono text-[10.5px] text-fg-subtle">
          {statusLabel}
        </span>
      </div>
      {notice ? (
        <div className="border-b border-line/12 px-3 py-1.5 font-mono text-[10.5px] text-fg-subtle">
          {notice}
        </div>
      ) : null}
      {view.kind === 'unsupported' ? (
        <UnsupportedPrompt onDelete={onDelete} />
      ) : view.kind === 'moved' ? (
        <MovedPrompt
          onReclaim={attach}
          onStartFresh={startFresh}
          pending={startFreshPending}
          startFreshError={startFreshError}
        />
      ) : view.kind === 'attachable' ? (
        <RestorePrompt
          prompt={view.resumeFailed ? 'resume_failed' : 'resume_available'}
          diagnosticCode={session?.diagnosticCode ?? null}
          diagnosticDetail={session?.diagnosticDetail ?? null}
          onResume={attach}
          onStartFresh={startFresh}
          startFreshPending={startFreshPending}
          startFreshError={startFreshError}
        />
      ) : view.kind === 'needs_fresh' ? (
        <RestorePrompt
          prompt="start_fresh"
          diagnosticCode={session?.diagnosticCode ?? null}
          diagnosticDetail={session?.diagnosticDetail ?? null}
          onResume={null}
          onStartFresh={startFresh}
          startFreshPending={startFreshPending}
          startFreshError={startFreshError}
        />
      ) : view.kind === 'live' && session ? (
        <PaneTerminal
          key={terminalKey}
          session={session}
          surfaceId={surface.id}
          paneId={pane.id}
          focused={focused}
          transport={transport}
          onRendererWarning={onRendererWarning}
        />
      ) : (
        <div className="grid min-h-0 flex-1 place-items-center px-4">
          <span className="font-mono text-[12px] text-fg-subtle">{ptyCopy.emptyPane}</span>
        </div>
      )}
      <PaneDeleteButton onDelete={onDelete} />
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

function UnsupportedPrompt({ onDelete }: { readonly onDelete: () => void }) {
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
        <Button variant="danger" size="sm" onClick={onDelete}>
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
