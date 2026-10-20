/**
 * Workspace facts the terminal presentation coordinator reacts to.
 *
 * One channel per app session (registry): the runtime-events connection, workspace commits and the
 * surface-detail read publish here, and the coordinator of the mounted terminal workspace
 * subscribes. Mounted editor panes also listen for `runtime_connected`, to relaunch a Code Server
 * a restarted runtime ended. Publishing is synchronous and needs no subscriber.
 */
import { Effect } from 'effect';
import { Atom, type AtomRegistry } from 'effect/reactivity';

import type { DurableSessionIdentity, RuntimeEvent, SurfaceDetail } from '@isagi/contracts';

import { makeChannel, sessionObject, type Channel } from '../../state/channel.js';

export type TerminalWorkspaceFact =
  | { readonly type: 'runtime_connected' }
  | { readonly type: 'runtime_event'; readonly event: RuntimeEvent }
  | { readonly type: 'durable_worktree_deleted'; readonly worktreeId: number }
  | { readonly type: 'durable_inventory_refresh_requested' }
  | {
      readonly type: 'placement_removed';
      readonly worktreeId: number;
      readonly surfaceId: number;
      readonly paneId?: number | undefined;
    }
  | { readonly type: 'durable_identity_deleted'; readonly identity: DurableSessionIdentity }
  /**
   * A surface-detail read landed. The coordinator re-derives terminal placements from it. Patches
   * of a held detail (`layout`, `activePaneId`) are not published: the projection ignores both.
   */
  | { readonly type: 'surface_detail_loaded'; readonly detail: SurfaceDetail };

export const terminalFactsAtom: Atom.Atom<Channel<TerminalWorkspaceFact>> = sessionObject(() =>
  makeChannel<TerminalWorkspaceFact>(),
);

/** Publish from plain code that holds the registry. */
export const publishTerminalFact = (
  registry: AtomRegistry.AtomRegistry,
  fact: TerminalWorkspaceFact,
): void => registry.get(terminalFactsAtom).publish(fact);

/** Publish from an app effect. */
export const publishTerminalFactEffect = (fact: TerminalWorkspaceFact) =>
  Effect.map(Atom.get(terminalFactsAtom), (facts) => facts.publish(fact));
