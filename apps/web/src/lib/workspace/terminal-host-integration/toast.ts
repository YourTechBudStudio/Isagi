import type { AtomRegistry } from 'effect/reactivity';

import { toastCopy } from '../../../copy/index.js';
import { showToast } from '../../toast/index.js';

/** One fixed id: repeated failures replace the toast instead of stacking. */
const CLIPBOARD_WRITE_FAILED_TOAST_ID = 'terminal-clipboard-write-failed';

/**
 * Terminal copies are out-of-band (a program asked, or a shortcut with no surface to answer in),
 * so a failed write is reported as a toast.
 */
export function clipboardWriteFailedToast(registry: AtomRegistry.AtomRegistry): void {
  showToast(registry, {
    id: CLIPBOARD_WRITE_FAILED_TOAST_ID,
    kind: 'warning',
    title: toastCopy.terminalClipboardWriteFailed.title,
    subtitle: toastCopy.terminalClipboardWriteFailed.subtitle,
  });
}
