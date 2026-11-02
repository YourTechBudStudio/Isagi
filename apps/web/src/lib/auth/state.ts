import { Atom, type AtomRegistry } from 'effect/reactivity';

import { onAuthRequired } from './signal.js';

/**
 * True once the runtime has refused this page's requests for want of credentials. Page-lifetime:
 * only a reload (after a sign-in) clears it, so nothing stale or failed survives into the workbench.
 */
export const signedOutAtom = Atom.make(false).pipe(Atom.keepAlive);

/**
 * True once `WorkspacePage` has mounted on this page. A sign-out while it is set shows the expiry
 * screen first; that screen's Sign in button clears it to open the sign-in view.
 */
export const workbenchShownAtom = Atom.make(false).pipe(Atom.keepAlive);

/** Connects the page's auth signal to its registry; called once per page, next to revalidation. */
export function connectAuthSignal(registry: AtomRegistry.AtomRegistry): () => void {
  return onAuthRequired(() => registry.set(signedOutAtom, true));
}
