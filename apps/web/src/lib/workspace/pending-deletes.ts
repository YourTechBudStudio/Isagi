import { useAtomValue } from '@effect/atom-react';
import { Atom, type AtomRegistry } from 'effect/reactivity';
import { useCallback } from 'react';

import { handleDispatchedCommandError, useCommandDispatcher } from '../palette/dispatcher.js';
import type { ArgValues } from '../palette/types.js';
import { useRegistry } from '../state/registry.js';
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

/** In-flight and failed deletes by target key, one map per app session (registry). */
export const pendingDeletesAtom = Atom.make<Readonly<Record<string, DeleteEntry>>>({}).pipe(
  Atom.keepAlive,
);

export function beginDelete(
  registry: AtomRegistry.AtomRegistry,
  key: string,
  origin: DeleteOrigin,
): void {
  registry.update(pendingDeletesAtom, (entriesByKey) => ({
    ...entriesByKey,
    [key]: { origin, error: null },
  }));
}

/** Records the failure on a delete still in flight; a target no longer tracked is ignored. */
export function failDelete(registry: AtomRegistry.AtomRegistry, key: string, error: string): void {
  registry.update(pendingDeletesAtom, (entriesByKey) => {
    const entry = entriesByKey[key];
    if (!entry) return entriesByKey;
    return { ...entriesByKey, [key]: { ...entry, error } };
  });
}

export function clearDelete(registry: AtomRegistry.AtomRegistry, key: string): void {
  registry.update(pendingDeletesAtom, (entriesByKey) => {
    if (!(key in entriesByKey)) return entriesByKey;
    const next = { ...entriesByKey };
    delete next[key];
    return next;
  });
}

export function paneDeleteKey(paneId: number) {
  return `pane:${paneId}`;
}

export function surfaceDeleteKey(surfaceId: number) {
  return `surface:${surfaceId}`;
}

/** The entry for one target, or `null` when nothing is in flight against it. */
export function useDeleteEntry(key: string): DeleteEntry | null {
  const select = useCallback(
    (entriesByKey: Readonly<Record<string, DeleteEntry>>) => entriesByKey[key] ?? null,
    [key],
  );
  return useAtomValue(pendingDeletesAtom, select);
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
  const registry = useRegistry();

  return useCallback(
    (request: RunDeleteRequest) => {
      const { key, origin, commandId, values } = request;
      // A second trigger for the same target is a double-click, not a new intent.
      // A pane delete is also blocked by a delete against its owning surface.
      if (isRunDeleteBlocked(request, registry.get(pendingDeletesAtom))) {
        return;
      }
      beginDelete(registry, key, origin);
      void dispatchCommand(commandId, values).then(
        () => clearDelete(registry, key),
        (error: unknown) => {
          if (origin === 'menu') {
            failDelete(registry, key, formatRuntimeError(error));
            handleDispatchedCommandError(registry, error, { toast: false });
            return;
          }
          clearDelete(registry, key);
          handleDispatchedCommandError(registry, error);
        },
      );
    },
    [dispatchCommand, registry],
  );
}
