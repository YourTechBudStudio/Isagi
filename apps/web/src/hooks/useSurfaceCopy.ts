import { useState } from 'react';

import { workbenchCopy } from '../copy/index.js';
import type { ClipboardCopyState } from './clipboard-copy.js';
import { useAnnouncement, type Announcement } from './useAnnouncement.js';
import { useClipboardCopy } from './useClipboardCopy.js';

/**
 * Copy-with-confirmation for a whole endpoint surface: one clipboard
 * controller, one live region, one notion of which copy is the current one.
 *
 * **The controller belongs to the surface, not to the badge.** There is one
 * system clipboard and one shared announcement, so "last invocation wins" has to
 * be decided across every affordance on the surface rather than inside each of
 * them. A badge that owned its own controller could only order its own clicks:
 * a slow write on one URL would settle after a newer write on a second URL and
 * announce its outcome over the newer one, and — in the drawer — dismiss the
 * panel over a failure the user still needed to read. Routing every attempt
 * through one controller retires the older attempt's token at the click, so its
 * settlement is dropped outright instead of being caught by a guard downstream.
 *
 * The badge is left presentational: it renders the state it is handed and
 * reports the click.
 *
 * Attempts are tracked by an opaque surface-local id rather than by the copied
 * text. Two badges may legitimately resolve to the same URL — a port's labels
 * are unique but its paths are not, so `docs → /api` and `api → /api` compose
 * one URL twice — and keying on the text would paint one click's outcome into
 * every badge that happens to match it, against ADR 0004's rule that feedback
 * stays inside the badge that was clicked.
 */
export function useSurfaceCopy(
  hooks: {
    /** Fired synchronously at the click, before the write is issued. */
    readonly onAttempt?: (() => void) | undefined;
    /** Fired for a confirmed copy that is still the surface's current attempt. */
    readonly onCopied?: (() => void) | undefined;
  } = {},
): {
  readonly announcement: Announcement;
  /** The state to render for one badge. Every other badge on the surface is idle. */
  readonly copyState: (badgeId: string) => ClipboardCopyState;
  /** `badgeId` identifies the affordance within this surface; `url` is what gets written. */
  readonly startCopy: (badgeId: string, url: string) => void;
} {
  const { announcement, announce } = useAnnouncement();
  const [attempted, setAttempted] = useState<string | null>(null);

  const { state, copy } = useClipboardCopy((settled) => {
    announce(
      settled === 'copied' ? workbenchCopy.commandUrlCopied : workbenchCopy.commandUrlCopyFailed,
    );
    if (settled === 'copied') {
      hooks.onCopied?.();
    }
  });

  return {
    announcement,
    copyState: (badgeId: string) => (badgeId === attempted ? state : 'idle'),
    startCopy: (badgeId: string, url: string) => {
      hooks.onAttempt?.();
      setAttempted(badgeId);
      copy(url);
    },
  };
}
