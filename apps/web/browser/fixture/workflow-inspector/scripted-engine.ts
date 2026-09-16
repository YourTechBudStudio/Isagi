import {
  createElkEngine,
  type LayoutEngine,
} from '../../../src/routes/workspace/workflow/elk-engine.js';
import type { LayoutRequest, LayoutResult } from '../../../src/routes/workspace/workflow/layout.js';

/**
 * A layout engine the page can hold, reorder and fail on demand.
 *
 * The rules under test — a stale answer cannot commit, a first failure is stated rather than drawn
 * as an empty graph, a later request recovers, and nothing commits after unmount — are all about
 * *when* answers arrive. A real engine answers as fast as it likes, so none of them can be observed
 * against it; scripting the timing is the only way to put them under test.
 *
 * It delegates to the real ELK engine for the layout itself, so what comes back is a real drawing
 * rather than a shape invented here.
 */

export interface ScriptedEngineControls {
  /** Hold every answer until released, so two requests can be made to overlap. */
  readonly holdAnswers: () => void;
  /** Release held answers newest-first, so a stale one lands last and must still be refused. */
  readonly releaseNewestFirst: () => void;
  /** Release held answers in the order they were requested. */
  readonly releaseInOrder: () => void;
  /** The next layout rejects, once. */
  readonly failNextLayout: () => void;
  /** The next engine cannot be constructed at all, which is a different failure from a bad layout. */
  readonly failNextEngine: () => void;
  /** How many engines have been disposed, so cleanup is observable. */
  readonly disposals: () => number;
  /** How many layouts have been asked for, and how many were made to fail. */
  readonly layouts: () => number;
  readonly failures: () => number;
  readonly factory: () => LayoutEngine;
}

export function createScriptedEngine(): ScriptedEngineControls {
  let holding = false;
  let failNext = false;
  let failEngine = false;
  let disposals = 0;
  let layouts = 0;
  let failures = 0;
  let pending: { readonly release: () => void }[] = [];

  return {
    holdAnswers: () => {
      holding = true;
    },
    releaseNewestFirst: () => {
      holding = false;
      const queued = [...pending].reverse();
      pending = [];
      for (const entry of queued) entry.release();
    },
    releaseInOrder: () => {
      holding = false;
      const queued = pending;
      pending = [];
      for (const entry of queued) entry.release();
    },
    failNextLayout: () => {
      failNext = true;
    },
    failNextEngine: () => {
      failEngine = true;
    },
    disposals: () => disposals,
    layouts: () => layouts,
    failures: () => failures,
    factory: () => {
      if (failEngine) {
        failEngine = false;
        throw new Error('scripted engine construction failure');
      }
      const real = createElkEngine();
      return {
        layout: async (request: LayoutRequest): Promise<LayoutResult> => {
          layouts += 1;
          if (failNext) {
            failNext = false;
            failures += 1;
            throw new Error('scripted layout failure');
          }
          const result = await real.layout(request);
          if (!holding) return result;
          return new Promise<LayoutResult>((resolve) => {
            pending.push({ release: () => resolve(result) });
          });
        },
        dispose: () => {
          disposals += 1;
          real.dispose();
        },
      };
    },
  };
}
