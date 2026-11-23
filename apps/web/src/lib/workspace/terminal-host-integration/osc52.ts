import type { IDisposable, Terminal } from '@xterm/xterm';

import { type TerminalClipboardWriter, writeTerminalClipboard } from './clipboard.js';

/** Base64 characters, about 1 MiB. Larger copy requests are ignored, not truncated. */
export const OSC52_MAX_PAYLOAD_LENGTH = 1024 * 1024;

export interface Osc52ClipboardOptions {
  /**
   * Asked on every copy request, at the moment xterm parses it. The installing host owns the
   * policy because it alone knows the state that matters (for example, replayed history).
   */
  readonly canWrite: () => boolean;
  readonly writeText: TerminalClipboardWriter;
  readonly onWriteFailed: () => void;
}

/**
 * Lets programs in the terminal copy to the user's clipboard with OSC 52
 * (`ESC ] 52 ; <selection> ; <base64> BEL|ST`), the way a terminal reached over SSH does.
 *
 * Write-only by design: a read request (`?`) gets no reply, so a program can never read the
 * user's clipboard. Invalid, empty and oversized payloads are dropped without touching the
 * clipboard.
 */
export function installOsc52Clipboard(
  terminal: Pick<Terminal, 'parser'>,
  options: Osc52ClipboardOptions,
): IDisposable {
  return terminal.parser.registerOscHandler(52, createOsc52Handler(options));
}

/**
 * The handler xterm calls with everything after `52;`. It always returns `true` synchronously,
 * so the sequence is consumed and the parser never waits on the clipboard.
 */
export function createOsc52Handler(options: Osc52ClipboardOptions): (data: string) => boolean {
  return (data) => {
    const text = decodeOsc52Write(data);
    if (text !== null && options.canWrite()) {
      writeTerminalClipboard(options.writeText, text, options.onWriteFailed);
    }
    return true;
  };
}

/** The text an OSC 52 body asks to copy, or `null` when it is not a usable write. */
export function decodeOsc52Write(data: string): string | null {
  const separator = data.indexOf(';');
  if (separator < 0) return null;
  const selection = data.slice(0, separator);
  const payload = data.slice(separator + 1);
  // `c` is the clipboard and `s` the selection xterm and most terminals treat as it. Primary
  // (`p`), cut buffers and the rest have no browser equivalent.
  if (selection !== '' && !/[cs]/.test(selection)) return null;
  if (payload === '' || payload === '?' || payload.length > OSC52_MAX_PAYLOAD_LENGTH) return null;
  let binary: string;
  try {
    binary = atob(payload);
  } catch {
    return null;
  }
  // `atob` yields one char per byte; decoding those bytes as UTF-8 keeps non-ASCII text intact.
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const text = new TextDecoder().decode(bytes);
  return text === '' ? null : text;
}
