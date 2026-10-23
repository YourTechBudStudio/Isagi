/**
 * Selection restoration and reconciliation: the decision `useWorkspaceSelectionSync` applies each
 * time the workspace, the active context or the selection changes.
 *
 * The decision is a pure function so every branch is testable without React; the hook only feeds
 * it the current values and applies the result. The little state it needs across runs lives in
 * `selectionSyncAtom`, one per app session.
 */
import type { ActiveContextOutput } from '@isagi/contracts';

import { toastCopy } from '../../copy/index.js';
import { sessionObject } from '../state/channel.js';
import type { ToastInput } from '../toast/index.js';
import { reconcileSelection, selectionFromActiveContext } from './model.js';
import type { Project, WorkspaceSelection } from './types.js';

export interface SelectionSyncInput {
  readonly selection: WorkspaceSelection;
  /** The workspace's projects, `undefined` until the first snapshot. */
  readonly projects: readonly Project[] | undefined;
  /** The persisted active context, `undefined`/`null` when there is none (or it is not loaded). */
  readonly activeContext: ActiveContextOutput['activeContext'] | null | undefined;
  /** The active-context read is failing (whether or not an earlier value is held). */
  readonly activeContextError: boolean;
  /** Projects whose restoration already asked for a reconcile this session. */
  readonly reconciled: ReadonlySet<number>;
}

export interface SelectionSyncDecision {
  /** The selection to apply, or `null` to leave it as it is. */
  readonly next: WorkspaceSelection | null;
  readonly toasts: readonly ToastInput[];
  /** A restored project to reconcile in the background (once per session per project). */
  readonly reconcileProjectId: number | null;
  /**
   * The selection change is a restoration, not a user choice: the persistence hook must not
   * write it back to the runtime it was just read from.
   */
  readonly suppressPersistence: boolean;
}

const unchanged: SelectionSyncDecision = {
  next: null,
  toasts: [],
  reconcileProjectId: null,
  suppressPersistence: false,
};

/**
 * - Nothing happens before the first workspace snapshot.
 * - An empty selection is hydrated from the persisted active context, once it (or its failure)
 *   is known; a failed active-context read warns and falls back to the default selection.
 * - Any other selection is reconciled against the current projects; a worktree selection that no
 *   longer exists moves to a sibling with a warning.
 * - A restored project is reconciled in the background once per session.
 */
export function nextSelectionSync(input: SelectionSyncInput): SelectionSyncDecision {
  const { selection, projects } = input;
  if (!projects) {
    return unchanged;
  }

  const restored = input.activeContext ?? null;
  if (selection.kind === 'empty' && !restored && !input.activeContextError) {
    return unchanged;
  }

  const toasts: ToastInput[] = [];
  if (selection.kind === 'empty' && input.activeContextError) {
    toasts.push({
      id: 'active-context-load-failed',
      kind: 'warning',
      title: toastCopy.activeContextLoadFailed.title,
      subtitle: toastCopy.activeContextLoadFailed.subtitle,
    });
  }

  const next =
    selection.kind === 'empty'
      ? selectionFromActiveContext(projects, restored ?? { projectId: null, worktreeId: null })
      : reconcileSelection(projects, selection);

  const restoredProjectId = selection.kind === 'empty' ? (restored?.projectId ?? null) : null;
  const reconcileProjectId =
    restoredProjectId && !input.reconciled.has(restoredProjectId) ? restoredProjectId : null;

  if (selectionEquals(selection, next)) {
    return { next: null, toasts, reconcileProjectId, suppressPersistence: false };
  }

  if (selection.kind === 'worktree' && next.kind === 'worktree') {
    toasts.push({
      id: `active-worktree-recovered:${selection.worktreeId}`,
      kind: 'warning',
      title: toastCopy.activeWorktreeRecovered.title,
      subtitle: toastCopy.activeWorktreeRecovered.subtitle,
      lifetime: { autoDismiss: false },
    });
  }
  return { next, toasts, reconcileProjectId, suppressPersistence: selection.kind === 'empty' };
}

/**
 * Per-session memory of the sync: the restored selection whose persistence echo must be skipped,
 * and the projects already reconciled for a restoration.
 */
export interface SelectionSyncState {
  suppressedPersistence: WorkspaceSelection | null;
  readonly reconciledProjectIds: Set<number>;
}

export const selectionSyncAtom = sessionObject((): SelectionSyncState => ({
  suppressedPersistence: null,
  reconciledProjectIds: new Set(),
}));

export function selectionEquals(left: WorkspaceSelection, right: WorkspaceSelection) {
  if (left.kind !== right.kind) {
    return false;
  }
  switch (left.kind) {
    case 'empty':
      return true;
    case 'missingProject':
      return left.projectId === (right as typeof left).projectId;
    case 'worktree':
      return (
        left.projectId === (right as typeof left).projectId &&
        left.worktreeId === (right as typeof left).worktreeId
      );
  }
}
