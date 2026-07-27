import { useCallback } from 'react';
import { create } from 'zustand';

import { handleDispatchedCommandError, useCommandDispatcher } from '../palette/dispatcher.js';
import type { ArgValues } from '../palette/types.js';
import { formatRuntimeError } from './runtime-data.js';

/**
 * In-flight surface/pane deletes, keyed by the thing being deleted.
 *
 * Deletes run without a confirmation step, so the second or two between the
 * click and the row disappearing is the only place the product can be honest
 * about what is happening. Two facts have to be shared across unrelated
 * components to do that, and neither belongs to a single one of them:
 *
 * - **which target is busy**, so every affordance that can act on it goes inert
 *   (a pane's cluster and its context menu are separate components, and a
 *   surface delete has to disable panes it does not render), and
 * - **which surface owns the feedback**, so the running indicator is drawn once,
 *   at the site the user actually touched — see ADR 0004.
 *
 * This is frontend interaction state, not server state: it is derived from a
 * command dispatch that is already in flight, and it dies with the target. The
 * runtime owns whether the delete succeeded; this owns where the user is looking
 * while they wait.
 */

/**
 * The surface that hosts the running indicator, chosen by whichever affordance
 * started the delete.
 *
 * - `pane` — the target's own inline control: the action cluster, or the close
 *   button on a blocked pane, which is the one pane shape with no cluster.
 * - `menu` — the right-click menu on a pane header or a rail surface row.
 *
 * `Cmd+W` has no affordance of its own, so it reports as `pane`. The cluster
 * pins visible while pending, which puts a keyboard delete in the same place a
 * moused one lands.
 */
export type DeleteOrigin = 'pane' | 'menu';

export interface DeleteEntry {
  readonly origin: DeleteOrigin;
  /**
   * Set only when the delete failed *and* the origin can host the message. A
   * failed entry no longer blocks the target's actions — it is a result the user
   * still has to read, not work still in progress.
   */
  readonly error: string | null;
}

interface PendingDeleteStore {
  readonly entriesByKey: Readonly<Record<string, DeleteEntry>>;
  readonly beginDelete: (key: string, origin: DeleteOrigin) => void;
  readonly failDelete: (key: string, error: string) => void;
  readonly clearDelete: (key: string) => void;
}

export const usePendingDeleteStore = create<PendingDeleteStore>((set) => ({
  entriesByKey: {},
  beginDelete: (key, origin) =>
    set((state) => ({ entriesByKey: { ...state.entriesByKey, [key]: { origin, error: null } } })),
  failDelete: (key, error) =>
    set((state) => {
      const entry = state.entriesByKey[key];
      if (!entry) return {};
      return { entriesByKey: { ...state.entriesByKey, [key]: { ...entry, error } } };
    }),
  clearDelete: (key) =>
    set((state) => {
      if (!(key in state.entriesByKey)) return {};
      const next = { ...state.entriesByKey };
      delete next[key];
      return { entriesByKey: next };
    }),
}));

export function paneDeleteKey(paneId: number) {
  return `pane:${paneId}`;
}

export function surfaceDeleteKey(surfaceId: number) {
  return `surface:${surfaceId}`;
}

/** The entry for one target, or `null` when nothing is in flight against it. */
export function useDeleteEntry(key: string): DeleteEntry | null {
  return usePendingDeleteStore((state) => state.entriesByKey[key] ?? null);
}

/**
 * True while the target's delete is still running. A failed entry is not pending:
 * its affordances come back so the user can retry or walk away.
 */
export function isDeletePending(entry: DeleteEntry | null): boolean {
  return entry !== null && entry.error === null;
}

/** Draw the running indicator here, and nowhere else. */
export function showsDeleteSweep(entry: DeleteEntry | null, origin: DeleteOrigin): boolean {
  return isDeletePending(entry) && entry?.origin === origin;
}

interface RunDeleteRequestBase {
  readonly key: string;
  readonly origin: DeleteOrigin;
  readonly values: ArgValues;
}

export type RunDeleteRequest =
  | (RunDeleteRequestBase & {
      readonly commandId: 'delete-active-pane';
      readonly surfaceId: number;
    })
  | (RunDeleteRequestBase & {
      readonly commandId: 'delete-active-surface';
    });

export function isRunDeleteBlocked(
  request: RunDeleteRequest,
  entriesByKey: Readonly<Record<string, DeleteEntry>>,
): boolean {
  const keys =
    request.commandId === 'delete-active-pane'
      ? [request.key, surfaceDeleteKey(request.surfaceId)]
      : [request.key];
  return keys.some((key) => isDeletePending(entriesByKey[key] ?? null));
}

/**
 * Dispatches a delete command and keeps the pending entry in step with it.
 *
 * Failure routing follows ADR 0004: a context menu is held open for the whole
 * operation, so it is still on screen to host the failure and does so inline. An
 * inline pane control is a 24px button with nowhere to put a runtime error, so
 * that path falls back to the toast the dispatcher already owns.
 */
export function useRunDelete() {
  const dispatchCommand = useCommandDispatcher();
  const beginDelete = usePendingDeleteStore((state) => state.beginDelete);
  const failDelete = usePendingDeleteStore((state) => state.failDelete);
  const clearDelete = usePendingDeleteStore((state) => state.clearDelete);

  return useCallback(
    (request: RunDeleteRequest) => {
      const { key, origin, commandId, values } = request;
      // A second trigger for the same target is a double-click, not a new intent.
      // A pane delete is also blocked by a delete against its owning surface.
      if (isRunDeleteBlocked(request, usePendingDeleteStore.getState().entriesByKey)) {
        return;
      }
      beginDelete(key, origin);
      void dispatchCommand(commandId, values).then(
        () => clearDelete(key),
        (error: unknown) => {
          if (origin === 'menu') {
            failDelete(key, formatRuntimeError(error));
            handleDispatchedCommandError(error, { toast: false });
            return;
          }
          clearDelete(key);
          handleDispatchedCommandError(error);
        },
      );
    },
    [beginDelete, clearDelete, dispatchCommand, failDelete],
  );
}
