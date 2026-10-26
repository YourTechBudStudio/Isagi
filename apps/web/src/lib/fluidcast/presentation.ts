import { useAtomValue } from '@effect/atom-react';
import { Command } from '@yourtechbudstudio/fluidcast-harness/protocol';
import { Effect, Schema } from 'effect';
import { AsyncResult, Atom } from 'effect/reactivity';
import { useEffect, useRef } from 'react';

import type { SurfaceDetail } from '@isagi/contracts';
import { RuntimeApiError } from '@isagi/runtime-client';

import { RuntimeApi } from '../runtime/client.js';
import { useRegistry } from '../state/registry.js';
import { forkApp } from '../state/runtime.js';
import { surfaceDetailAtom } from '../workspace/queries.js';
import { fluidcastPendingPausesAtom } from './pending-pauses.js';

// Visibility is the web's fact: a Fluidcast session is presented while its pane is on the active
// surface. Zen, the drawer, focus and blur never change the active surface, so they pause nothing.

/** Fluidcast session IDs of the given surface detail's Fluidcast-mode agent panes. */
export const presentedFluidcastSessions = (detail: SurfaceDetail): ReadonlySet<string> => {
  const ids = new Set<string>();
  for (const pane of detail.panes) {
    const interaction =
      pane.session?.kind === 'agent_session' ? pane.session.agentSession.interaction : null;
    if (interaction?.mode === 'fluidcast') ids.add(interaction.fluidcastSessionId);
  }
  return ids;
};

export interface Presented {
  readonly surfaceId: number | null;
  readonly ids: ReadonlySet<string>;
}

export const nothingPresented: Presented = { surfaceId: null, ids: new Set() };

/**
 * The next presented set. On the same surface a loaded detail replaces it, and a refetch or a
 * failed read keeps the last one; on a different surface (or none) the new surface's set applies at
 * once if it has loaded, otherwise nothing is presented, so every session of the previous surface
 * leaves together.
 */
export const nextPresented = (
  previous: Presented,
  surfaceId: number | null,
  detail: AsyncResult.AsyncResult<SurfaceDetail, unknown>,
): Presented => {
  const loaded = AsyncResult.isSuccess(detail) ? presentedFluidcastSessions(detail.value) : null;
  if (surfaceId !== null && surfaceId === previous.surfaceId) {
    return loaded === null ? previous : { surfaceId, ids: loaded };
  }
  return { surfaceId, ids: surfaceId === null ? new Set() : (loaded ?? new Set()) };
};

/** IDs that left between two presented sets. */
export const leftPresentation = (previous: Presented, next: Presented): ReadonlyArray<string> =>
  [...previous.ids].filter((id) => !next.ids.has(id));

/** The SDK's encoded `Pause`, as the transport sends every command. */
const pauseCommand = Schema.encodeSync(Command)({ _tag: 'Pause' });

/**
 * The hide `Pause` for one session, tracked so a returning player waits for it. A session that is
 * gone, or that cannot pause in its current phase, needs nothing; any other failure is logged with
 * the session ID (and still counts as failed for the returning player).
 */
export const pauseHiddenSession = (fluidcastSessionId: string) =>
  Effect.gen(function* () {
    const api = yield* RuntimeApi;
    const pendingPauses = yield* Atom.get(fluidcastPendingPausesAtom);
    const send = api.sendFluidcastCommand(fluidcastSessionId, pauseCommand).pipe(
      Effect.asVoid,
      Effect.catch((error) =>
        error instanceof RuntimeApiError &&
        (error.apiError.code === 'fluidcast_session_not_found' ||
          error.apiError.code === 'fluidcast_command_rejected')
          ? Effect.void
          : Effect.logWarning('[fluidcast] hide pause failed', {
              fluidcastSessionId,
              error: error._tag,
              code: error instanceof RuntimeApiError ? error.apiError.code : undefined,
            }).pipe(Effect.andThen(Effect.fail(error))),
      ),
    );
    yield* pendingPauses.track(fluidcastSessionId, send);
  });

const nothingLoaded = Atom.make(AsyncResult.initial<SurfaceDetail, Error>()).pipe(Atom.keepAlive);

/**
 * Pauses exactly the Fluidcast sessions that leave the active surface. Mounted once, beside
 * `TerminalPresentationProvider` and outside `WorkArea`. Nothing is sent from unmount cleanups, and
 * the diff is idempotent, so StrictMode's double effects send nothing extra.
 */
export function useFluidcastPresentation(activeSurfaceId: number | null): void {
  const registry = useRegistry();
  const detail = useAtomValue<AsyncResult.AsyncResult<SurfaceDetail, Error>>(
    activeSurfaceId === null ? nothingLoaded : surfaceDetailAtom(activeSurfaceId),
  );
  const presented = useRef<Presented>(nothingPresented);

  useEffect(() => {
    const next = nextPresented(presented.current, activeSurfaceId, detail);
    const left = leftPresentation(presented.current, next);
    presented.current = next;
    for (const id of left) forkApp(registry, pauseHiddenSession(id));
  }, [activeSurfaceId, detail, registry]);
}
