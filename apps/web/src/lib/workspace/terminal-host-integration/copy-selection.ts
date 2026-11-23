import type { Terminal } from '@xterm/xterm';

import { isMacPlatform } from '../../platform.js';
import { type TerminalClipboardWriter, writeTerminalClipboard } from './clipboard.js';

export interface TerminalSelectionCopyOptions {
  readonly host: HTMLElement;
  readonly terminal: Pick<Terminal, 'getSelection'>;
  readonly writeText: TerminalClipboardWriter;
  readonly onWriteFailed: () => void;
  /** Every keydown that is not a selection copy, still in the capture phase. */
  readonly onKeyDown?: ((event: KeyboardEvent) => void) | undefined;
}

/**
 * The terminal's own copy: the platform copy shortcut (Cmd+C on macOS, Ctrl+Shift+C elsewhere)
 * and the browser `copy` event both put the current selection on the clipboard.
 *
 * The keydown listener runs in the capture phase so it sees the shortcut before xterm turns it
 * into input. Without a selection the shortcut falls through to `onKeyDown`, so Ctrl+C stays an
 * interrupt. Returns the uninstaller.
 */
export function installTerminalSelectionCopy(options: TerminalSelectionCopyOptions): () => void {
  const { host, terminal } = options;
  const handleKeyDown = (event: KeyboardEvent) => {
    const selection = isCopyShortcut(event) ? terminal.getSelection() : '';
    if (selection) {
      event.preventDefault();
      event.stopPropagation();
      writeTerminalClipboard(options.writeText, selection, options.onWriteFailed);
      return;
    }
    options.onKeyDown?.(event);
  };
  // Synchronous `clipboardData`: there is no asynchronous failure to report on this path.
  const handleCopy = (event: ClipboardEvent) => {
    const selection = terminal.getSelection();
    if (!selection) return;
    event.clipboardData?.setData('text/plain', selection);
    event.preventDefault();
  };
  host.addEventListener('keydown', handleKeyDown, true);
  host.addEventListener('copy', handleCopy);
  return () => {
    host.removeEventListener('keydown', handleKeyDown, true);
    host.removeEventListener('copy', handleCopy);
  };
}

export function isCopyShortcut(event: KeyboardEvent): boolean {
  if (event.type !== 'keydown' || event.key.toLowerCase() !== 'c') return false;
  return isMacPlatform()
    ? event.metaKey && !event.altKey
    : event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey;
}
