import {
  CircleDashed,
  CircleHelp,
  PanelBottom,
  PanelRight,
  RotateCw,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import type { EditorDiagnosticsOutput } from '@isagi/contracts';

import { Button } from '../../components/Button.js';
import { ContextMenu } from '../../components/ContextMenu.js';
import { PaneActionCluster } from '../../components/PaneActionCluster.js';
import {
  editorAttemptFailureCopy,
  editorCopy,
  editorPaneStatusCopy,
  editorSettledCopy,
  editorSettledStatusLabel,
} from '../../copy/index.js';
import type {
  EditorAttemptBanner,
  EditorPaneView,
  EditorSettledReason,
  EditorStartIntent,
} from '../../lib/editor/view.js';
import { editorSettledCode, editorStartIntent } from '../../lib/editor/view.js';
import { usePaneFocusTarget } from '../../lib/workspace/activation.js';
import type { DeleteOrigin } from '../../lib/workspace/pending-deletes.js';
import { paneSessionIcon } from '../../lib/workspace/surface-presentation.js';
import { EditorFrame } from './EditorFrame.js';
import { EditorWait } from './EditorWait.js';

/** The on-demand read of one incarnation's retained startup output. */
export type EditorDiagnosticsState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly output: EditorDiagnosticsOutput }
  | { readonly kind: 'failed'; readonly detail: string };

/**
 * Split, delete, and the pending-delete locking every pane shares.
 *
 * Delete carries its origin because the running indicator is drawn once, at the
 * affordance the user actually touched (ADR 0004) — the two pending flags are
 * the same `showsDeleteSweep` answer a PTY pane computes, asked per control.
 * Collapsing them would put the sweep on both controls, or on the wrong one.
 */
export interface EditorPaneActions {
  readonly onSplitRight: () => void;
  readonly onSplitDown: () => void;
  readonly onDelete: (origin: DeleteOrigin) => void;
  /** A delete owned by this pane or its surface is running; everything is inert. */
  readonly locked: boolean;
  /** The context menu started it, so the menu item carries the sweep. */
  readonly menuDeletePending: boolean;
  /** The action cluster started it — or `Cmd+W`, which reports as `pane`. */
  readonly clusterDeletePending: boolean;
  readonly deleteError: string | null;
  readonly onDeleteResultDismissed: () => void;
}

/** Where this pane sits, for the shared keyboard-focus router only. */
export interface EditorPaneFocusTarget {
  readonly surfaceId: number;
  readonly paneId: number;
}

/**
 * The editor pane.
 *
 * Everything it renders arrives as props. That is not a mock accommodation: the
 * pane's whole job is to render one projection honestly, and keeping the data
 * plumbing outside it means the state machine can be reviewed against every
 * combination without a runtime, and wired to live queries without a rewrite.
 *
 * It carries no `AttentionDot`. An editor never asks for a turn — it is either
 * usable, on its way, or broken, and all three are already in the header.
 */
export function EditorPane({
  title,
  view,
  banner,
  notice,
  activePtyProcessId,
  hasDiagnostics,
  focused,
  onFocus,
  starting,
  onStart,
  diagnostics,
  onToggleDiagnostics,
  onRetryDiagnostics,
  actions = null,
  focusTarget = null,
}: {
  readonly title: string;
  readonly view: EditorPaneView;
  /** A failed attempt that left the previous incarnation standing. */
  readonly banner: EditorAttemptBanner | null;
  /**
   * A request-local failure the runtime never recorded — a dropped connection, a
   * refusal that arrived under the pane. It renders in every state, including
   * `idle` and `ready`, because an ensure fired on mount can fail while the
   * cached projection still reads idle, and a failure has to be visible at the
   * place the user acted.
   */
  readonly notice: string | null;
  readonly activePtyProcessId: number | null;
  readonly hasDiagnostics: boolean;
  readonly focused: boolean;
  readonly onFocus: () => void;
  readonly starting: boolean;
  readonly onStart: (intent: EditorStartIntent) => void;
  readonly diagnostics: EditorDiagnosticsState;
  readonly onToggleDiagnostics: () => void;
  readonly onRetryDiagnostics: () => void;
  readonly actions?: EditorPaneActions | null;
  /**
   * Supplied by whatever mounts the pane inside a surface. Absent in the fixture
   * and the component tests, which have no workspace identity to register under.
   */
  readonly focusTarget?: EditorPaneFocusTarget | null;
}) {
  const Icon = paneSessionIcon('editor_context');
  const sectionRef = useRef<HTMLElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const url = view.kind === 'ready' ? view.url : null;

  // The other half of the activation seam. Entering the workbench makes this
  // pane active; this is how keyboard focus comes *back* to it when the palette
  // or the drawer closes. Focusing the frame element puts keystrokes back inside
  // Code Server; with no workbench up, the pane itself is the honest landing
  // place, which is also what keeps a broken editor keyboard-reachable.
  const focusWorkbench = useCallback(() => {
    const frame = frameRef.current;
    if (frame) {
      frame.focus({ preventScroll: true });
      return;
    }
    sectionRef.current?.focus({ preventScroll: true });
  }, []);
  // One target, not the shell/terminal pair a PTY pane registers: the editor has
  // exactly one hero, and the ref above already says whether it is mounted. The
  // ids are inert placeholders until a caller supplies a real identity.
  usePaneFocusTarget({
    surfaceId: focusTarget?.surfaceId ?? -1,
    paneId: focusTarget?.paneId ?? -1,
    enabled: focusTarget !== null,
    priority: 0,
    focus: focusWorkbench,
  });

  // A replacement is a different workbench behind the same pane. Covering it
  // again is the honest reading of "this document has not painted yet".
  useEffect(() => setFrameLoaded(false), [url]);

  const errored = view.kind === 'settled' && view.reason.kind !== 'unknown';
  const locked = actions?.locked ?? false;
  // Once the probe has settled ready *and* the document has actually painted,
  // the workbench owns the pane outright and Isagi's header is done: it is not
  // hidden pending a gesture, it is gone. Three things still pin it — a
  // request-local failure, a refused replacement, and a running delete — none of
  // which the user should have to go looking for.
  //
  // There is deliberately no reveal trigger. Hover and focus both made the
  // header flicker in and out while the user was working, which is noise rather
  // than an affordance, and focus was worse than noise: the only focusable thing
  // in this pane is the workbench, so it fired at exactly the wrong moment.
  // Right-click inside a live workbench belongs to VS Code, and `PaneActionCluster`
  // — a sibling of this header, not a child — keeps split and delete reachable.
  const workbenchOwnsPane =
    view.kind === 'ready' && frameLoaded && notice === null && banner === null && !locked;

  const header = (
    <div className="flex min-h-9 items-center gap-2 border-b border-line/15 px-3 py-2">
      <Icon size={13} className="text-fg-subtle" />
      <span className="truncate font-mono text-[11.5px] text-fg-muted">{title}</span>
      <span
        className={`ml-auto truncate font-mono text-[10.5px] ${
          errored ? 'text-error' : view.kind === 'ready' ? 'text-waiting' : 'text-fg-subtle'
        }`}
      >
        {view.kind === 'settled'
          ? editorSettledStatusLabel(view.reason)
          : editorPaneStatusCopy[view.kind]}
      </span>
    </div>
  );

  const withPaneMenu = (children: ReactElement) =>
    actions ? (
      <ContextMenu
        items={[
          {
            label: 'Split Right',
            icon: PanelRight,
            disabled: locked,
            onSelect: actions.onSplitRight,
          },
          {
            label: 'Split Down',
            icon: PanelBottom,
            disabled: locked,
            onSelect: actions.onSplitDown,
          },
          {
            label: 'Delete pane',
            icon: Trash2,
            danger: true,
            keepsMenuOpen: true,
            pending: actions.menuDeletePending,
            disabled: locked,
            onSelect: () => actions.onDelete('menu'),
          },
        ]}
        error={actions.deleteError}
        onResultDismissed={actions.onDeleteResultDismissed}
      >
        {children}
      </ContextMenu>
    ) : (
      children
    );

  return (
    <section
      ref={sectionRef}
      aria-label={title}
      tabIndex={-1}
      onPointerDown={locked ? undefined : onFocus}
      className={`group relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-md border bg-elevated/50 backdrop-blur-sm transition-colors duration-ui ease-expo ${
        errored ? 'border-error/35' : focused ? 'border-blue/40' : 'border-line/20'
      }`}
    >
      {workbenchOwnsPane ? null : withPaneMenu(header)}

      {notice ? (
        <p className="border-b border-error/16 bg-error/5 px-3 py-1.5 font-mono text-[10.5px] leading-relaxed text-error">
          {notice}
        </p>
      ) : null}

      {banner ? (
        // Amber, not red: nothing was destroyed and the old editor is still
        // serving. What follows below is that surviving incarnation.
        <div className="flex items-start gap-2 border-b border-amber/20 bg-amber/7 px-3 py-2 text-[12px] leading-relaxed text-amber">
          <TriangleAlert size={13} aria-hidden className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p>{editorAttemptFailureCopy[banner.reason]}</p>
            {/* The runtime's own words, kept out of ours and labelled with the
                code it failed under — the same framing the settled surface and
                the provisioning chip use. */}
            {banner.detail ? (
              <p className="mt-0.5 font-mono text-[10.5px] leading-relaxed wrap-break-word text-amber/75">
                {banner.reason} · {banner.detail}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {view.kind === 'ready' ? (
        <EditorFrame
          url={view.url}
          title={title}
          loaded={frameLoaded}
          onLoaded={() => setFrameLoaded(true)}
          // Entering the workbench is entering this pane. Nothing to promote when
          // it is already active, and promoting a pane mid-delete would retarget
          // the pane-scoped commands at it.
          onActivate={locked || focused ? null : onFocus}
          frameRef={frameRef}
        />
      ) : (
        withPaneMenu(
          <div className="flex min-h-0 flex-1 flex-col">
            {view.kind === 'launching' || view.kind === 'waiting_for_workbench' ? (
              <>
                <span aria-hidden className="command-sweep" />
                <div className="grid min-h-0 flex-1 place-items-center px-6 py-5">
                  <EditorWait
                    text={
                      view.kind === 'launching'
                        ? editorCopy.launching
                        : editorCopy.waitingForWorkbench
                    }
                  />
                </div>
              </>
            ) : (
              <EditorPrompt
                view={view}
                activePtyProcessId={activePtyProcessId}
                hasDiagnostics={hasDiagnostics}
                starting={starting}
                onStart={onStart}
                diagnostics={diagnostics}
                onToggleDiagnostics={onToggleDiagnostics}
                onRetryDiagnostics={onRetryDiagnostics}
              />
            )}
          </div>,
        )
      )}

      {actions ? (
        <PaneActionCluster
          onSplitRight={actions.onSplitRight}
          onSplitDown={actions.onSplitDown}
          onDelete={() => actions.onDelete('pane')}
          disabled={locked}
          deletePending={actions.clusterDeletePending}
        />
      ) : null}
    </section>
  );
}

/**
 * The settled and idle surfaces: one glyph, one sentence, the runtime's own
 * diagnostic, and the action. The same shape a restore prompt uses, so a broken
 * editor reads like every other broken pane in the workspace.
 */
function EditorPrompt({
  view,
  activePtyProcessId,
  hasDiagnostics,
  starting,
  onStart,
  diagnostics,
  onToggleDiagnostics,
  onRetryDiagnostics,
}: {
  readonly view: Extract<EditorPaneView, { kind: 'idle' | 'settled' }>;
  readonly activePtyProcessId: number | null;
  readonly hasDiagnostics: boolean;
  readonly starting: boolean;
  readonly onStart: (intent: EditorStartIntent) => void;
  readonly diagnostics: EditorDiagnosticsState;
  readonly onToggleDiagnostics: () => void;
  readonly onRetryDiagnostics: () => void;
}) {
  const intent = editorStartIntent(view);
  const failed = view.kind === 'settled' && view.reason.kind !== 'unknown';
  const Glyph = view.kind === 'idle' ? CircleDashed : failed ? TriangleAlert : CircleHelp;
  // A failed launch is retried; a settled incarnation is replaced. Naming the
  // latter explicitly keeps the recovery action clear instead of asking the
  // user to infer that a generic retry means "restart this process".
  const label =
    view.kind === 'idle'
      ? editorCopy.action.start
      : view.reason.kind === 'attempt_failed'
        ? editorCopy.action.retry
        : editorCopy.action.restart;
  const showDiagnostics = view.kind === 'settled' && hasDiagnostics && activePtyProcessId !== null;
  const open = diagnostics.kind !== 'closed';

  return (
    <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto px-6 py-5">
      <div className="flex w-full max-w-md flex-col items-center gap-3 text-center">
        <Glyph size={18} aria-hidden className={failed ? 'text-error' : 'text-fg-subtle'} />
        <p className="max-w-[38ch] font-mono text-[12px] leading-relaxed text-fg-muted">
          {view.kind === 'idle' ? editorCopy.idle : editorSettledCopy(view.reason)}
        </p>
        {view.kind === 'settled' && view.detail ? (
          <EditorSettledDetail reason={view.reason} detail={view.detail} />
        ) : null}
        <div className="mt-0.5 flex flex-wrap items-center justify-center gap-2">
          {intent ? (
            <Button
              variant="primary"
              size="sm"
              {...(failed ? { icon: RotateCw } : {})}
              disabled={starting}
              onClick={() => onStart(intent)}
            >
              {starting ? editorCopy.action.starting : label}
            </Button>
          ) : null}
          {showDiagnostics ? (
            <Button variant="ghost" size="sm" onClick={onToggleDiagnostics}>
              {open ? editorCopy.diagnostics.hide : editorCopy.diagnostics.show}
            </Button>
          ) : null}
        </div>
        {showDiagnostics && open && activePtyProcessId !== null ? (
          <EditorDiagnostics
            ptyProcessId={activePtyProcessId}
            state={diagnostics}
            onRetry={onRetryDiagnostics}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * The runtime's raw settling detail, framed as evidence rather than voiced.
 *
 * The code it settled under leads the line for the same reason a restore prompt
 * leads with its diagnostic code: a user reading this has to be able to tell
 * Isagi's sentence above from the string the runtime handed us, and the code is
 * the thing that makes a bug report searchable.
 */
function EditorSettledDetail({
  reason,
  detail,
}: {
  readonly reason: EditorSettledReason;
  readonly detail: string;
}) {
  return (
    <p className="max-w-[46ch] font-mono text-[10.5px] leading-relaxed wrap-break-word text-fg-subtle">
      <span className="text-fg-muted">{editorSettledCode(reason)}</span> · {detail}
    </p>
  );
}

/**
 * A bounded tail of Code Server's own startup output. Closed by default: it is
 * what keeps a large, noisy artifact off a calm failure surface while still
 * putting it one click from the person who has to report the problem.
 *
 * It is labelled evidence, never our voice, and never parsed. A failed read is
 * reported inside the disclosure with a retry for the read alone — failing to
 * read a log says nothing about the editor's own state.
 */
function EditorDiagnostics({
  ptyProcessId,
  state,
  onRetry,
}: {
  readonly ptyProcessId: number;
  readonly state: EditorDiagnosticsState;
  readonly onRetry: () => void;
}) {
  // `totalBytes` is a byte count off disk, so the excerpt has to be measured in
  // bytes too — subtracting a UTF-16 string length would overstate the drop on
  // any run whose output is not pure ASCII.
  const dropped =
    state.kind === 'loaded' && state.output.truncated && state.output.totalBytes !== null
      ? state.output.totalBytes - utf8Length(state.output.excerpt ?? '')
      : null;

  return (
    <section
      aria-label={editorCopy.diagnostics.label(ptyProcessId)}
      className="mt-2 w-full text-left"
    >
      <p className="mb-1.5 font-mono text-[10px] tracking-widest text-fg-subtle uppercase">
        {editorCopy.diagnostics.label(ptyProcessId)}
      </p>
      {state.kind === 'loading' ? (
        <span aria-hidden className="command-sweep rounded-full" />
      ) : state.kind === 'failed' ? (
        <div className="rounded-sm border border-line/30 bg-scrim/50 px-3 py-2">
          <p className="font-mono text-[10.5px] leading-relaxed text-fg-subtle">{state.detail}</p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-1.5 font-mono text-[10.5px] text-fg-muted underline-offset-2 hover:underline"
          >
            {editorCopy.diagnostics.retry}
          </button>
        </div>
      ) : state.kind === 'loaded' ? (
        <pre className="max-h-40 overflow-auto rounded-sm border border-line/30 bg-scrim/50 px-3 py-2 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-fg-muted">
          {dropped !== null && dropped > 0 ? (
            <span className="block text-fg-subtle">
              {editorCopy.diagnostics.truncated(dropped)}
            </span>
          ) : null}
          {state.output.excerpt === null || state.output.excerpt === ''
            ? editorCopy.diagnostics.empty
            : state.output.excerpt}
        </pre>
      ) : null}
    </section>
  );
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}
