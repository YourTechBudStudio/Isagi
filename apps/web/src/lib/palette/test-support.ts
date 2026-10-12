/**
 * Test-only helpers for palette contexts. Never import from production code.
 */
import type { AtomRegistry } from 'effect/reactivity';

import { runApp } from '../state/runtime.js';
import { makeTestRegistry } from '../state/testing.js';
import type { PaletteContext } from './types.js';

/**
 * The app-session half of a `PaletteContext`: a registry (a fresh test registry unless the test
 * passes the one it asserts against) and an `app` runner bound to it.
 */
export function paletteTestSession(
  registry: AtomRegistry.AtomRegistry = makeTestRegistry(),
): Pick<PaletteContext, 'registry' | 'app'> {
  return { registry, app: (effect) => runApp(registry, effect) };
}
