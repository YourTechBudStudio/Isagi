/**
 * An Escape nothing inside the page has handled yet. Page-level Escape handlers (zen, the drawer)
 * listen on `window` in the bubble phase and act only on these, so an embedded surface that uses
 * Escape itself, such as a Fluidcast player interrupting speech, keeps it.
 */
export const isUnclaimedEscape = (event: Pick<KeyboardEvent, 'key' | 'defaultPrevented'>) =>
  event.key === 'Escape' && !event.defaultPrevented;
