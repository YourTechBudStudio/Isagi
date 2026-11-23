/**
 * Writes text to the clipboard of the machine the user is sitting at. Rejects when the write
 * cannot happen, whether the API is missing or the browser refused it.
 */
export type TerminalClipboardWriter = (text: string) => Promise<void>;

/**
 * The live clipboard, looked up on every write rather than captured once: the API can be absent
 * (an insecure context) and anything wrapping `navigator.clipboard` must be honored as it is now.
 * There is deliberately no `execCommand('copy')` fallback.
 */
export const browserClipboardWriter: TerminalClipboardWriter = (text) => {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (typeof clipboard?.writeText !== 'function') {
    return Promise.reject(new Error('The clipboard API is unavailable.'));
  }
  try {
    return clipboard.writeText(text);
  } catch (error) {
    return Promise.reject(error);
  }
};

/** Fire-and-forget: a failure is reported once through `onWriteFailed`, never thrown. */
export function writeTerminalClipboard(
  writer: TerminalClipboardWriter,
  text: string,
  onWriteFailed: () => void,
): void {
  let pending: Promise<void>;
  try {
    pending = writer(text);
  } catch {
    onWriteFailed();
    return;
  }
  void pending.then(undefined, () => onWriteFailed());
}
