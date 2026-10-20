import { useAtomValue } from '@effect/atom-react';
import { Effect } from 'effect';
import { Atom, Reactivity } from 'effect/reactivity';

import type {
  AgentSessionInteractionMode,
  AgentSessionInteractionOrigin,
  AgentSessionMetadata,
} from '@isagi/contracts';
import { RuntimeApiError } from '@isagi/runtime-client';

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
 * Switches one agent pane between its terminal and Fluidcast. `from` is the controller the user's
 * projection showed; the runtime refuses the switch when the agent has moved on since. The write is
 * uninterruptible, so a second click or an unmount never cuts a switch that reached the runtime.
 * Either outcome re-reads the surface (which carries the pane's interaction) and the workspace
 * (status and attention): a failed switch changes the projection too, by recording a failure or
 * keeping a terminal.
 */
export const setPaneInteraction = (input: {
  readonly surfaceId: number;
  readonly paneId: number;
  readonly agentSessionId: number;
  readonly mode: AgentSessionInteractionMode;
  readonly from: AgentSessionInteractionOrigin;
}) =>
  Effect.gen(function* () {
    const api = yield* RuntimeApi;
    yield* updatePending(input.paneId, true);
    yield* Effect.uninterruptible(
      api.setAgentInteractionMode(input.agentSessionId, { mode: input.mode, from: input.from }),
    );
  }).pipe(
    Effect.ensuring(Reactivity.invalidate([keys.surface(input.surfaceId), keys.workspace])),
    Effect.ensuring(updatePending(input.paneId, false)),
  );

const handoffFailureCodes: ReadonlySet<string> = new Set([
  'fluidcast_session_unreadable',
  'fluidcast_start_failed',
  'agent_terminal_stop_failed',
]);

/** A switch that failed after cleanup began: the pane's own failure panel shows it, so no toast repeats it. */
export function isHandoffFailure(error: unknown): boolean {
  return error instanceof RuntimeApiError && handoffFailureCodes.has(error.apiError.code);
}

/** The `from` of a switch made against this projection of the agent. */
export function interactionOrigin(
  agentSession: AgentSessionMetadata,
): AgentSessionInteractionOrigin {
  const { interaction } = agentSession;
  return {
    generation: interaction.generation,
    fluidcastSessionId: interaction.mode === 'fluidcast' ? interaction.fluidcastSessionId : null,
    processIncarnation: agentSession.processIncarnation,
  };
}
