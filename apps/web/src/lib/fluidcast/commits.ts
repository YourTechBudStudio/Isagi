import { useAtomValue } from '@effect/atom-react';
import { Effect } from 'effect';
import { Atom, Reactivity } from 'effect/reactivity';

import type { AgentSessionInteractionMode } from '@isagi/contracts';

import { RuntimeApi } from '../runtime/client.js';
import { keys } from '../state/keys.js';

/**
 * Panes whose interaction switch is in flight. Frontend interaction state: it only says where the
 * user is waiting, so the pane's toggle shows the running sweep and goes inert. The runtime owns the
 * mode itself.
 */
export const pendingInteractionSwitchesAtom = Atom.make<ReadonlySet<number>>(
  new Set<number>(),
).pipe(Atom.keepAlive);

export const useInteractionSwitchPending = (paneId: number): boolean =>
  useAtomValue(pendingInteractionSwitchesAtom, (pending) => pending.has(paneId));

const updatePending = (paneId: number, pending: boolean) =>
  Atom.update(pendingInteractionSwitchesAtom, (current) => {
    if (current.has(paneId) === pending) return current;
    const next = new Set(current);
    if (pending) next.add(paneId);
    else next.delete(paneId);
    return next;
  });

/**
 * Switches one agent pane between its terminal and Fluidcast. The write is uninterruptible, so a
 * second click or an unmount never cuts a switch that reached the runtime. On success the surface
 * (which carries the pane's interaction) and the workspace (status and attention) are re-read.
 */
export const setPaneInteraction = (input: {
  readonly surfaceId: number;
  readonly paneId: number;
  readonly agentSessionId: number;
  readonly mode: AgentSessionInteractionMode;
}) =>
  Effect.gen(function* () {
    const api = yield* RuntimeApi;
    yield* updatePending(input.paneId, true);
    yield* Effect.uninterruptible(api.setAgentInteractionMode(input.agentSessionId, input.mode));
    yield* Reactivity.invalidate([keys.surface(input.surfaceId), keys.workspace]);
  }).pipe(Effect.ensuring(updatePending(input.paneId, false)));
