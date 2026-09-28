import { useEffect, useRef, useState } from 'react';

import { createElkEngine, type LayoutEngine } from './elk-engine.js';
import type { LayoutRequest, LayoutResult } from './layout.js';

/**
 * One engine, and answers accepted only for the shape currently being asked about.
 *
 * Everything here is keyed by *identity* — the shape a request describes — rather than by arrival
 * order, because arrival order is exactly what cannot be trusted. Two shapes can be in flight at
 * once, a failure and a success can land in either order, and a request for a shape nobody wants any
 * more can answer at any time. Keying on identity makes each of those unambiguous:
 *
 * - **The previous drawing stays on screen while a new shape is laid out.** No placeholder after the
 *   first paint; opening a box should not blank the graph somebody is reading.
 * - **An answer for a shape that is no longer wanted is dropped**, whether it succeeded or failed.
 * - **A failure is reported for as long as its shape is the one being asked about.** A later answer
 *   for a *different* shape cannot clear it, and a stale success cannot overwrite it.
 */

export interface GraphLayoutState {
  /** The most recent committed positions, or null before the first successful layout. */
  readonly result: LayoutResult | null;
  /** True while the current shape has no answer yet. */
  readonly pending: boolean;
  /** Set when the current shape's layout failed; the drawing, if any, is of an older shape. */
  readonly failure: string | null;
}

/** Swappable so a test can drive the protocol without a real engine. */
export interface LayoutEngineFactory {
  (): LayoutEngine;
}

interface Internal {
  readonly result: LayoutResult | null;
  readonly settledIdentity: string | null;
  readonly failure: { readonly identity: string; readonly message: string } | null;
  /**
   * An engine that could not be constructed at all.
   *
   * Deliberately not keyed by identity: there is no request yet when a factory throws, so filing it
   * against the wanted shape files it against nothing and it disappears — leaving a canvas that
   * waits forever for an engine that does not exist. It applies to every shape until one is built.
   */
  readonly engineFailure: string | null;
}

export function useGraphLayout(
  request: LayoutRequest | null,
  options: { readonly factory?: LayoutEngineFactory | undefined } = {},
): GraphLayoutState {
  const [state, setState] = useState<Internal>({
    result: null,
    settledIdentity: null,
    failure: null,
    engineFailure: null,
  });
  const engineRef = useRef<LayoutEngine | null>(null);
  const wantedRef = useRef<string | null>(null);
  const factory = options.factory ?? createElkEngine;

  useEffect(() => {
    let engine: LayoutEngine;
    try {
      engine = factory();
    } catch (error) {
      setState((current) => ({
        ...current,
        engineFailure: error instanceof Error ? error.message : String(error),
      }));
      return;
    }
    engineRef.current = engine;
    setState((current) =>
      current.engineFailure === null ? current : { ...current, engineFailure: null },
    );
    return () => {
      // Nothing may commit after this: the ref is cleared first so an answer still in flight cannot
      // find an engine to belong to, and the engine's own worker is ended.
      engineRef.current = null;
      wantedRef.current = null;
      engine.dispose();
    };
  }, [factory]);

  const identity = request?.identity ?? null;
  useEffect(() => {
    if (identity === null || !request) return;
    const engine = engineRef.current;
    if (!engine) return;
    wantedRef.current = identity;

    void engine.layout(request).then(
      (result) => {
        if (wantedRef.current !== result.identity) return;
        setState((current) => ({
          ...current,
          result,
          settledIdentity: result.identity,
          failure: null,
        }));
      },
      (error: unknown) => {
        if (wantedRef.current !== identity) return;
        setState((current) => ({
          ...current,
          failure: {
            identity,
            message: error instanceof Error ? error.message : String(error),
          },
        }));
      },
    );
    // Only the identity may trigger a layout. `request` is rebuilt on every render of the canvas,
    // and depending on it would lay the graph out again on every status change — the exact twitch
    // this design forbids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);

  // An engine that never existed outranks a request that could never be made.
  const failure =
    state.engineFailure ?? (state.failure?.identity === identity ? state.failure.message : null);
  return {
    result: state.result,
    pending: identity !== null && state.settledIdentity !== identity && failure === null,
    failure,
  };
}
