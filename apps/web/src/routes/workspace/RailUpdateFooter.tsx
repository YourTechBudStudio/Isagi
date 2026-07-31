import type { ReactNode } from 'react';

import { updateCopy } from '../../copy/updates.js';
import { RestartConfirmation, type RestartActivity } from './RestartConfirmation.js';

/**
 * What the rail footer knows about the desktop update. This is the component's
 * own view shape rather than the wire contract: the host's `restart_confirmation`
 * snapshot arrives here as `ready` plus a `confirmRestart` activity, because the
 * footer's restart control is the same control either way. The mapping from the
 * contract union lives in {@link ./useDesktopUpdate}.
 */
export type DesktopUpdateState =
  /** No desktop host (a hosted web build): the footer renders nothing at all. */
  | { readonly kind: 'unsupported' }
  /** Unpackaged development host: the installed version, and no GitHub implication. */
  | { readonly kind: 'disabled' }
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'up-to-date' }
  | { readonly kind: 'downloading'; readonly version: string; readonly percent: number }
  | { readonly kind: 'ready'; readonly version: string }
  | { readonly kind: 'installing'; readonly version: string }
  | { readonly kind: 'check-failed' }
  | { readonly kind: 'download-failed'; readonly version: string }
  /**
   * A build that cannot replace itself (an unwritable Linux AppImage): the user
   * fetches it. It carries no version — this state is decided during composition,
   * before any provider is contacted, so no available version is known.
   *
   * `openFailed` is the host's report that the last press did not reach a
   * browser. It stays the same state and the same control, because the remedy is
   * unchanged and pressing again is exactly the right thing to do.
   */
  | { readonly kind: 'manual-required'; readonly openFailed: boolean };

export interface RailUpdateFooterProps {
  readonly state: DesktopUpdateState;
  readonly installedVersion: string;
  /**
   * Agent activity as of the moment the user asked to restart. `null` means the
   * host is not asking for confirmation; an activity opens the anchored warning.
   * The host owns this fact — the component never decides to ask.
   */
  readonly confirmRestart?: RestartActivity | null;
  /**
   * A restart request is in flight. Purely an in-flight interaction fact, not
   * updater truth: the host is reading agent activity and has not yet said
   * whether it will restart or ask first.
   */
  readonly restartPending?: boolean;
  readonly onCheck: () => void;
  readonly onRestart: () => void;
  readonly onCancelRestart: () => void;
  readonly onConfirmRestart: () => void;
  readonly onRetryDownload: () => void;
  readonly onOpenDownloadPage: () => void;
}

/**
 * The rail's foot: the installed version, and everything the desktop update has
 * to say about itself.
 *
 * The whole surface is one line plus a 2px hairline on the rail's bottom edge.
 * That is the design: an update is a property of the application, not an item in
 * the navigation. Nothing is ever inserted into or removed from the rail's
 * layout — the hairline's track is always present and only its fill changes — so
 * a download starting can never nudge the project list, and the work surface
 * stays the loudest thing on screen.
 *
 * Progress is a bounded fill, never a sweep and never a spinner: the updater
 * reports a real percentage, so the bar shows the percentage. The indeterminate
 * `command-sweep` is for work of unknown length and would be a lie here.
 *
 * Errors stay at the interaction site. A scheduled check that fails never
 * reaches this component (it stays `idle`); what surfaces here is a failure the
 * user asked for, which is why it is allowed to spend the reserved red.
 */
export function RailUpdateFooter({
  state,
  installedVersion,
  confirmRestart = null,
  restartPending = false,
  onCheck,
  onRestart,
  onCancelRestart,
  onConfirmRestart,
  onRetryDownload,
  onOpenDownloadPage,
}: RailUpdateFooterProps) {
  if (state.kind === 'unsupported') return null;

  // Only a settled `idle` invites a manual check. Every other state either has
  // work in flight or owns its own action, and a second entry point into the
  // same operation is how duplicate checks happen.
  const versionInteractive = state.kind === 'idle';

  return (
    <div data-update-footer data-update-state={state.kind}>
      {/* Fixed height, not padding. The trailing slot swaps between nothing, a
          mono token, and a control with a real hit area, and each of those has a
          different natural line box — on padding alone the row would breathe by
          a few pixels every time the state changed, which is exactly the motion
          this treatment exists to avoid. */}
      <div className="flex h-9 items-center gap-2 px-4">
        <button
          type="button"
          onClick={versionInteractive ? onCheck : undefined}
          disabled={!versionInteractive}
          title={versionInteractive ? updateCopy.actions.check : undefined}
          aria-label={
            versionInteractive
              ? updateCopy.actions.check
              : updateCopy.described.installed(installedVersion)
          }
          data-version-control
          className="rounded-sm font-mono text-[11px] text-fg-subtle opacity-50 transition-opacity duration-micro ease-expo not-disabled:hover:opacity-90 focus-visible:opacity-90 focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-line/60"
        >
          v{installedVersion}
        </button>
        {/* Polite, because none of these transitions are worth interrupting
            whatever the user is reading in the work surface. */}
        <span className="ml-auto" role="status" aria-live="polite">
          <Trailing
            state={state}
            confirmRestart={confirmRestart}
            restartPending={restartPending}
            onCheck={onCheck}
            onRestart={onRestart}
            onCancelRestart={onCancelRestart}
            onConfirmRestart={onConfirmRestart}
            onRetryDownload={onRetryDownload}
            onOpenDownloadPage={onOpenDownloadPage}
          />
        </span>
      </div>
      <Hairline state={state} />
    </div>
  );
}

/** The mono token — or, when there is something to do, the control — on the version line. */
function Trailing({
  state,
  confirmRestart,
  restartPending,
  onCheck,
  onRestart,
  onCancelRestart,
  onConfirmRestart,
  onRetryDownload,
  onOpenDownloadPage,
}: {
  state: DesktopUpdateState;
  confirmRestart: RestartActivity | null;
  restartPending: boolean;
  onCheck: () => void;
  onRestart: () => void;
  onCancelRestart: () => void;
  onConfirmRestart: () => void;
  onRetryDownload: () => void;
  onOpenDownloadPage: () => void;
}) {
  switch (state.kind) {
    case 'unsupported':
    case 'disabled':
    case 'idle':
      return null;
    case 'checking':
      return <Token>{updateCopy.status.checking}</Token>;
    case 'up-to-date':
      return <Token tone="muted">{updateCopy.status.upToDate}</Token>;
    case 'downloading':
      return (
        <Token
          tone="muted"
          className="tabular-nums"
          label={updateCopy.described.downloading(state.version, state.percent)}
        >
          {updateCopy.status.downloading(state.percent)}
        </Token>
      );
    case 'installing':
      // No control at all while the app is closing: the action is already
      // committed, and a second press has nothing left to do.
      return (
        <Token label={updateCopy.described.installing(state.version)}>
          {updateCopy.status.installing}
        </Token>
      );
    case 'ready':
      // The confirmation stays mounted around the trigger for the whole ready
      // state, closed until the host asks. It is not mounted on demand: the
      // activity result arrives after the click, so a popover mounted at that
      // moment would open without a transition, and the one mounted for the
      // cancel would unmount before it could close or restore focus.
      return (
        <RestartConfirmation
          activity={confirmRestart}
          version={state.version}
          onCancel={onCancelRestart}
          onProceed={onConfirmRestart}
          trigger={
            <Control
              onClick={onRestart}
              // Only while the request is in flight. It must be enabled again by
              // the time the confirmation closes, or Base UI cannot return focus
              // to it — and while the confirmation is open the modal popover
              // already makes it unreachable.
              disabled={restartPending}
              tone="waiting"
              label={updateCopy.described.restart(state.version)}
              data-restart-control
            >
              {updateCopy.actions.restart}
            </Control>
          }
        />
      );
    case 'check-failed':
      return (
        <Control
          tone="error"
          onClick={onCheck}
          label={updateCopy.described.checkFailed}
          data-retry-control
        >
          {updateCopy.status.checkFailed}
        </Control>
      );
    case 'download-failed':
      return (
        <Control
          tone="error"
          onClick={onRetryDownload}
          label={updateCopy.described.downloadFailed(state.version)}
          data-retry-control
        >
          {updateCopy.status.downloadFailed}
        </Control>
      );
    case 'manual-required':
      // One control, two readings. A launch that failed spends the reserved red
      // and says so, but it is the same target doing the same thing: the user
      // asked for this, so the failure belongs at the press.
      return (
        <Control
          tone={state.openFailed ? 'error' : 'amber'}
          onClick={onOpenDownloadPage}
          label={
            state.openFailed
              ? updateCopy.described.downloadPageFailed
              : updateCopy.described.manualRequired
          }
          data-manual-control
          data-open-failed={state.openFailed || undefined}
        >
          {state.openFailed
            ? updateCopy.status.downloadPageFailed
            : updateCopy.status.manualRequired}
        </Control>
      );
  }
}

/**
 * The hairline on the rail's bottom edge. The track is always rendered, even
 * when it carries nothing, so the footer's height is constant across every
 * state and the rail above it never moves.
 */
function Hairline({ state }: { state: DesktopUpdateState }) {
  if (state.kind === 'downloading') {
    return (
      <div
        role="progressbar"
        aria-label={updateCopy.described.downloading(state.version, state.percent)}
        aria-valuenow={state.percent}
        aria-valuemin={0}
        aria-valuemax={100}
        data-update-hairline="downloading"
        className="h-0.5 w-full overflow-hidden bg-line/16"
      >
        <div
          className="h-full bg-linear-to-r from-blue to-violet transition-[width] duration-surface ease-expo motion-reduce:transition-none"
          style={{ width: `${state.percent}%` }}
        />
      </div>
    );
  }

  // A failed launch reads as a failure on the edge too, matching the control it
  // sits under — the state is still `manual-required`, only its last attempt is not.
  const fill =
    state.kind === 'manual-required' && state.openFailed
      ? HAIRLINE_FILL['check-failed']
      : HAIRLINE_FILL[state.kind];
  return (
    <div
      aria-hidden
      data-update-hairline={fill ? state.kind : 'none'}
      className={`h-0.5 w-full ${fill ?? ''}`}
    />
  );
}

const HAIRLINE_FILL: Partial<Record<DesktopUpdateState['kind'], string>> = {
  ready: 'bg-waiting/45',
  installing: 'bg-waiting/25',
  'check-failed': 'bg-error/45',
  'download-failed': 'bg-error/45',
  'manual-required': 'bg-amber/40',
};

const TOKEN_TONE = {
  subtle: 'text-fg-subtle',
  muted: 'text-fg-muted',
} as const;

function Token({
  children,
  tone = 'subtle',
  className = '',
  label,
}: {
  children: ReactNode;
  tone?: keyof typeof TOKEN_TONE;
  className?: string;
  label?: string;
}) {
  return (
    <span aria-label={label} className={`font-mono text-[11px] ${TOKEN_TONE[tone]} ${className}`}>
      {children}
    </span>
  );
}

const CONTROL_TONE = {
  waiting: 'text-waiting focus-visible:outline-waiting/60',
  error: 'font-mono text-error focus-visible:outline-error/60',
  amber: 'font-mono text-amber focus-visible:outline-amber/60',
} as const;

/**
 * A control that reads as part of the status line rather than as a button. It
 * keeps the ambient treatment while still being a real target: the negative
 * margin buys it a comfortable hit area without pushing the line around.
 */
function Control({
  children,
  tone,
  onClick,
  label,
  disabled = false,
  ...rest
}: {
  children: ReactNode;
  tone: keyof typeof CONTROL_TONE;
  onClick: () => void;
  label: string;
  disabled?: boolean;
} & Record<`data-${string}`, string | boolean | undefined>) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      {...rest}
      // Dimmed, not restyled: the control is briefly unavailable, not a
      // different control, and the line must not change metrics.
      className={`-mx-1.5 -my-1 rounded-sm px-1.5 py-1 text-[11.5px] transition-opacity duration-micro ease-expo not-disabled:hover:opacity-75 disabled:opacity-45 focus-visible:outline-1 focus-visible:outline-offset-2 ${CONTROL_TONE[tone]}`}
    >
      {children}
    </button>
  );
}

export type { RestartActivity };
