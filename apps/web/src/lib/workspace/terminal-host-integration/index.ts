/**
 * Everything between an xterm instance and the user's local clipboard, shared by every terminal
 * so their copy behavior cannot drift. Each piece installs on its own: a terminal whose stream
 * replays history without a gate takes the selection copy but not the OSC 52 handler.
 */
export { browserClipboardWriter, type TerminalClipboardWriter } from './clipboard.js';
export {
  installTerminalSelectionCopy,
  type TerminalSelectionCopyOptions,
} from './copy-selection.js';
export {
  createOsc52Handler,
  decodeOsc52Write,
  installOsc52Clipboard,
  OSC52_MAX_PAYLOAD_LENGTH,
  type Osc52ClipboardOptions,
} from './osc52.js';
export { clipboardWriteFailedToast } from './toast.js';
