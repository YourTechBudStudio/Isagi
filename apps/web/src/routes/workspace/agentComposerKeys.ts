/**
 * Shift+Enter in an agent harness means "newline in my composer", not "submit". A bare `\n`
 * would be indistinguishable from Enter, so the newline is wrapped in bracketed paste: that is
 * how a terminal says the byte is text the program should insert rather than a key it should
 * act on.
 *
 * Returns whether the key was consumed, matching the controller's custom-key contract.
 */
export function sendAgentComposerNewline(
  event: KeyboardEvent,
  sendInput: (data: string) => void,
): boolean {
  if (event.key !== 'Enter' || !event.shiftKey) return false;
  event.preventDefault();
  event.stopPropagation();
  sendInput('\x1b[200~\n\x1b[201~');
  return true;
}
