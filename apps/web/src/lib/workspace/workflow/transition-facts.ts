import type { WorkflowRunTransitionDelta } from '@isagi/contracts';

import type { WorkflowPauseInterval, WorkflowRunState } from './model.js';

export interface WorkflowRunFacts {
  readonly pauseIntervals: readonly WorkflowPauseInterval[];
  readonly currentArtifactHash: string | null;
}

/**
 * The two things a delta carries that no entity row does: when the run was paused, and when it
 * adopted a new pin.
 *
 * Only these are kept. Retaining every transition would grow without bound with the length of a
 * run, for facts the execution and frame rows already carry; these two grow with how often a person
 * pauses or retries, which is bounded in practice.
 *
 * Applying is idempotent by revision, because recovery legitimately re-reads revisions a live delta
 * already delivered and a band opened twice would be a band that never closes.
 */
export function applyTransitionFacts(
  state: WorkflowRunState,
  delta: WorkflowRunTransitionDelta,
): WorkflowRunState {
  switch (delta.transition.kind) {
    case 'pause_opened': {
      if (state.pauseIntervals.some((band) => band.openedAtRevision === delta.revision)) {
        return state;
      }
      const opened: WorkflowPauseInterval = {
        openedAtRevision: delta.revision,
        openedAt: delta.transition.recordedAt,
        closedAt: null,
        closedAtRevision: null,
      };
      return {
        ...state,
        pauseIntervals: [...state.pauseIntervals, opened].sort(
          (left, right) => left.openedAtRevision - right.openedAtRevision,
        ),
      };
    }
    case 'pause_closed': {
      // Closes the band this revision actually ended: the last one opened *before* it that is still
      // open. "Whichever band happens to be open" was wrong on replay — a recovery re-reading an
      // earlier close over a cache that already holds a later, still-open pause would have closed
      // the wrong one, and stamped it with a time from the past.
      const openIndex = state.pauseIntervals.findLastIndex(
        (band) => band.closedAt === null && band.openedAtRevision < delta.revision,
      );
      if (openIndex === -1) return state;
      const pauseIntervals = [...state.pauseIntervals];
      pauseIntervals[openIndex] = {
        ...pauseIntervals[openIndex]!,
        closedAt: delta.transition.recordedAt,
        closedAtRevision: delta.revision,
      };
      return { ...state, pauseIntervals };
    }
    case 'retry_pin_adopted': {
      const artifactHash = delta.transition.artifactHash;
      if (artifactHash === null) return state;
      if (state.pinAdoptions.some((adoption) => adoption.revision === delta.revision)) return state;
      return {
        ...state,
        pinAdoptions: [
          ...state.pinAdoptions,
          { revision: delta.revision, artifactHash, adoptedAt: delta.transition.recordedAt },
        ].sort((left, right) => left.revision - right.revision),
      };
    }
    default:
      return state;
  }
}

/**
 * The pin a client should be drawing.
 *
 * The summary is authoritative when it is present; the adoption list is what lets a client notice a
 * Retry it missed while disconnected, because recovery replays the adoption even though no entity
 * row changed shape.
 */
export function currentArtifactHash(state: WorkflowRunState): string | null {
  return state.summary?.artifactHash ?? state.pinAdoptions.at(-1)?.artifactHash ?? null;
}
