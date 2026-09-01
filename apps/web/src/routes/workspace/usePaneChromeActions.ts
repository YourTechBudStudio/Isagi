import { useCallback, useMemo } from 'react';

import {
  handleDispatchedCommandError,
  useCommandDispatcher,
} from '../../lib/palette/dispatcher.js';
import { activatePane } from '../../lib/workspace/activation.js';
import {
  isDeletePending,
  paneDeleteKey,
  showsDeleteSweep,
  surfaceDeleteKey,
  useDeleteEntry,
  usePendingDeleteStore,
  useRunDelete,
  type DeleteOrigin,
} from '../../lib/workspace/pending-deletes.js';

/**
 * The split/delete chrome every pane shares, regardless of what it holds.
 *
 * Split targeting, focus-before-dispatch, delete origin, the locking a running
 * delete imposes, and which affordance owns the running sweep are the same rules
 * for a terminal and for an editor — and they are rules about *panes*, not about
 * what is inside one. Keeping one implementation is what stops the next change
 * to delete semantics from having to be made twice.
 *
 * It deliberately owns no presentation: menu items, action-cluster placement,
 * header behavior, session eligibility, and focus registration stay with each
 * pane, because those genuinely differ.
 */
export interface PaneChromeActions {
  /** Promote this pane before acting on it, so `Cmd+W` and pane commands agree. */
  readonly focusPane: () => void;
  readonly onSplitRight: () => void;
  readonly onSplitDown: () => void;
  readonly onDelete: (origin: DeleteOrigin) => void;
  /** A delete owning this pane or its surface is running; everything goes inert. */
  readonly locked: boolean;
  /** The running sweep belongs to whichever affordance the user actually touched. */
  readonly menuDeletePending: boolean;
  readonly clusterDeletePending: boolean;
  readonly deleteError: string | null;
  readonly onDeleteResultDismissed: () => void;
}

export function usePaneChromeActions(input: {
  readonly worktreeId: number;
  readonly surfaceId: number;
  readonly paneId: number;
}): PaneChromeActions {
  const { worktreeId, surfaceId, paneId } = input;
  const dispatchCommand = useCommandDispatcher();
  const runDelete = useRunDelete();
  const clearDelete = usePendingDeleteStore((state) => state.clearDelete);
  const paneKey = paneDeleteKey(paneId);
  const paneDelete = useDeleteEntry(paneKey);
  const surfaceDelete = useDeleteEntry(surfaceDeleteKey(surfaceId));
  const locked = isDeletePending(paneDelete) || isDeletePending(surfaceDelete);

  const focusPane = useCallback(() => {
    activatePane({ worktreeId, surfaceId, paneId });
  }, [paneId, surfaceId, worktreeId]);

  const paneValues = useMemo(
    () => ({
      worktreeId: String(worktreeId),
      surfaceId: String(surfaceId),
      paneId: String(paneId),
    }),
    [paneId, surfaceId, worktreeId],
  );

  const dispatchPaneCommand = useCallback(
    (commandId: 'split-pane-right' | 'split-pane-down') => {
      focusPane();
      void dispatchCommand(commandId, paneValues).catch(handleDispatchedCommandError);
    },
    [dispatchCommand, focusPane, paneValues],
  );

  const onSplitRight = useCallback(() => {
    dispatchPaneCommand('split-pane-right');
  }, [dispatchPaneCommand]);

  const onSplitDown = useCallback(() => {
    dispatchPaneCommand('split-pane-down');
  }, [dispatchPaneCommand]);

  const onDelete = useCallback(
    (origin: DeleteOrigin) => {
      focusPane();
      runDelete({
        key: paneKey,
        origin,
        commandId: 'delete-active-pane',
        surfaceId,
        values: paneValues,
      });
    },
    [focusPane, paneKey, paneValues, runDelete, surfaceId],
  );

  const onDeleteResultDismissed = useCallback(() => {
    if (paneDelete?.error) clearDelete(paneKey);
  }, [clearDelete, paneDelete, paneKey]);

  return {
    focusPane,
    onSplitRight,
    onSplitDown,
    onDelete,
    locked,
    menuDeletePending: showsDeleteSweep(paneDelete, 'menu'),
    clusterDeletePending: showsDeleteSweep(paneDelete, 'pane'),
    deleteError: paneDelete?.error ?? null,
    onDeleteResultDismissed,
  };
}
