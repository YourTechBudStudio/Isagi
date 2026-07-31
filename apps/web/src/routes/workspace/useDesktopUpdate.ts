import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import {
  desktopUpdateActions,
  hasDesktopUpdateHost,
  reconcileRevision,
  subscribeDesktopUpdate,
  type DesktopUpdateSnapshot,
} from '../../lib/desktop-bridge.js';
import type { DesktopUpdateState } from './RailUpdateFooter.js';
import type { RestartActivity } from './RestartConfirmation.js';

/**
 * What the rail should render. The three cases are genuinely different facts,
 * and the hook names them so the rail never re-derives host availability:
 *
 * - `unsupported` — no desktop host at all. A hosted web build has no version to
 *   show and no update to offer, so it shows no footer.
 * - `unresolved` — a host is present but its first snapshot has not arrived. The
 *   rail reserves the footer's geometry rather than letting it appear a moment
 *   later and shove the project list up.
 * - `resolved` — the host has spoken.
 */
export type DesktopUpdateView =
  | { readonly presence: 'unsupported' }
  | { readonly presence: 'unresolved' }
  | {
      readonly presence: 'resolved';
      readonly state: DesktopUpdateState;
      readonly installedVersion: string;
      readonly confirmRestart: RestartActivity | null;
      readonly restartPending: boolean;
      readonly onCheck: () => void;
      readonly onRestart: () => void;
      readonly onCancelRestart: () => void;
      readonly onConfirmRestart: () => void;
      readonly onRetryDownload: () => void;
      readonly onOpenDownloadPage: () => void;
    };

/**
 * The contract snapshot as the footer sees it. Three shapes differ from the wire:
 * `restart_confirmation` becomes `ready` plus an activity, because it is the
 * same control in the same place with a question attached; `failed` splits by
 * operation, because the two failures have different recovery text; and the
 * manual-install failure code collapses to a flag, because the footer only has
 * to know that the last press failed, not which code said so.
 */
export function toDesktopUpdateState(snapshot: DesktopUpdateSnapshot): DesktopUpdateState {
  switch (snapshot.state) {
    case 'disabled':
      return { kind: 'disabled' };
    case 'idle':
      return { kind: 'idle' };
    case 'checking':
      return { kind: 'checking' };
    case 'up_to_date':
      return { kind: 'up-to-date' };
    case 'downloading':
      return {
        kind: 'downloading',
        version: snapshot.targetVersion,
        percent: Math.round(snapshot.progressPercent),
      };
    case 'ready':
    case 'restart_confirmation':
      return { kind: 'ready', version: snapshot.targetVersion };
    case 'installing':
      return { kind: 'installing', version: snapshot.targetVersion };
    case 'manual_update_required':
      return { kind: 'manual-required', openFailed: snapshot.openFailure !== null };
    case 'failed':
      return snapshot.operation === 'check'
        ? { kind: 'check-failed' }
        : { kind: 'download-failed', version: snapshot.targetVersion };
  }
}

/** Only a `restart_confirmation` snapshot asks. Everything else is silent. */
export function toRestartActivity(snapshot: DesktopUpdateSnapshot): RestartActivity | null {
  if (snapshot.state !== 'restart_confirmation') return null;
  return snapshot.activity.kind === 'working'
    ? { kind: 'working', workingAgentCount: snapshot.activity.workingAgentCount }
    : { kind: 'unknown' };
}

export interface DesktopUpdateHostState {
  readonly snapshot: DesktopUpdateSnapshot | null;
  readonly restartPending: boolean;
}

export type DesktopUpdateEvent =
  | { readonly kind: 'snapshot'; readonly snapshot: DesktopUpdateSnapshot }
  | { readonly kind: 'restart_requested' }
  | { readonly kind: 'restart_settled' };

export const initialDesktopUpdateState: DesktopUpdateHostState = {
  snapshot: null,
  restartPending: false,
};

/**
 * The whole of the hook's state, kept here as one pure transition so it can be
 * reasoned about and tested without a renderer.
 *
 * `restartPending` is an in-flight interaction, not updater truth, and it clears
 * on two independent signals. The invoke promise settling is the primary one,
 * because the desktop may legitimately treat a request as a no-op and publish
 * nothing at all — a rule that waited for a revision would leave the control
 * disabled forever in exactly that case. Leaving `ready` is the backstop, for
 * the symmetric case where the renderer is torn down or the reply never lands.
 */
export function desktopUpdateReducer(
  state: DesktopUpdateHostState,
  event: DesktopUpdateEvent,
): DesktopUpdateHostState {
  switch (event.kind) {
    case 'snapshot': {
      const snapshot = reconcileRevision(state.snapshot, event.snapshot);
      if (snapshot === state.snapshot) return state;
      return { snapshot, restartPending: state.restartPending && snapshot.state === 'ready' };
    }
    case 'restart_requested':
      return state.restartPending ? state : { ...state, restartPending: true };
    case 'restart_settled':
      return state.restartPending ? { ...state, restartPending: false } : state;
  }
}

export interface DesktopUpdateHandlers {
  readonly onCheck: () => void;
  readonly onRestart: () => void;
  readonly onCancelRestart: () => void;
  readonly onConfirmRestart: () => void;
  readonly onOpenDownloadPage: () => void;
}

/**
 * Assembles what the rail renders from host presence, host state, and the
 * intents. Pure, so the whole seam between a contract snapshot and the footer's
 * props can be exercised without a renderer or a bridge.
 */
export function resolveDesktopUpdateView(
  hosted: boolean,
  state: DesktopUpdateHostState,
  handlers: DesktopUpdateHandlers,
): DesktopUpdateView {
  if (!hosted) return { presence: 'unsupported' };
  if (!state.snapshot) return { presence: 'unresolved' };
  return {
    presence: 'resolved',
    state: toDesktopUpdateState(state.snapshot),
    installedVersion: state.snapshot.installedVersion,
    confirmRestart: toRestartActivity(state.snapshot),
    restartPending: state.restartPending,
    ...handlers,
    // Retrying a download restarts the whole check/download lifecycle; there is
    // no separate resume operation, and the updater downloads automatically once
    // it finds the update again.
    onRetryDownload: handlers.onCheck,
  };
}

export function useDesktopUpdate(): DesktopUpdateView {
  const [hosted] = useState(hasDesktopUpdateHost);
  const [{ snapshot, restartPending }, dispatch] = useReducer(
    desktopUpdateReducer,
    initialDesktopUpdateState,
  );
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!hosted) return;
    return subscribeDesktopUpdate((next) => dispatch({ kind: 'snapshot', snapshot: next }));
  }, [hosted]);

  const onRestart = useCallback(() => {
    dispatch({ kind: 'restart_requested' });
    void desktopUpdateActions.requestRestart().finally(() => {
      if (mounted.current) dispatch({ kind: 'restart_settled' });
    });
  }, []);

  const onCheck = useCallback(() => void desktopUpdateActions.check(), []);
  const onCancelRestart = useCallback(() => void desktopUpdateActions.cancelRestart(), []);
  const onConfirmRestart = useCallback(() => void desktopUpdateActions.confirmRestart(), []);
  const onOpenDownloadPage = useCallback(() => void desktopUpdateActions.openDownloadPage(), []);

  return resolveDesktopUpdateView(
    hosted,
    { snapshot, restartPending },
    { onCheck, onRestart, onCancelRestart, onConfirmRestart, onOpenDownloadPage },
  );
}
