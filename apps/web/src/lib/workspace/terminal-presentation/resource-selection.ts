import type { TerminalVisibilityAcquisition } from '../terminal-cache/index.js';
import type { TerminalPresentationController } from './controller.js';

/**
 * Which controller a pane should mount right now.
 *
 * A visibility acquisition captures the entry's resource at acquisition time,
 * and preparation is asynchronous — the pane routinely acquires visibility while
 * the entry is still `preparing`, so `acquisition.resource` is `null` on a lease
 * that is otherwise perfectly current. Installing the controller changes the
 * entry's lifecycle but not its attachment epoch, so that lease is never
 * reacquired and its captured `null` never refreshes.
 *
 * Treating an acquired-but-empty lease as "no terminal" therefore strands a
 * fully built controller — live claim, open socket, real xterm — behind an empty
 * pane. The lease decides *whether* this pane may show the terminal; the freshly
 * prepared controller decides *which object* to show when the lease predates it.
 */
export function selectPresentationResource(input: {
  readonly acquisition: TerminalVisibilityAcquisition<TerminalPresentationController> | null;
  readonly prepared: TerminalPresentationController | null;
}): TerminalPresentationController | null {
  if (input.acquisition && input.acquisition.status !== 'acquired') return null;
  return input.acquisition?.resource ?? input.prepared;
}
