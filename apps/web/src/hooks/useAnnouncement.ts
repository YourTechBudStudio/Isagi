import { useCallback, useState } from 'react';

/**
 * One announcement, plus the sequence number that makes a *repeat* of it a
 * distinct event.
 *
 * The sequence exists because a polite live region is driven by DOM mutation,
 * not by intent. Copying the same URL twice sets the same message string, React
 * renders no change, and the second copy is announced to nobody — even though
 * the visible in-badge confirmation flashed again. The counter turns "copied"
 * said twice into two events without changing a word of what is spoken.
 */
export interface Announcement {
  readonly message: string;
  readonly seq: number;
}

const SILENT: Announcement = { message: '', seq: 0 };

/**
 * The announcement half of a surface that reports copy outcomes. Pair it with
 * `LiveAnnouncement`, which is what actually re-arms between messages.
 *
 * The surface owns this rather than the badge that produced the outcome: badges
 * re-render, unmount when a popover dismisses, and are replaced wholesale when a
 * command's ports change, and a live region that goes away with its trigger
 * announces nothing.
 */
export function useAnnouncement(): {
  readonly announcement: Announcement;
  readonly announce: (message: string) => void;
} {
  const [announcement, setAnnouncement] = useState<Announcement>(SILENT);
  const announce = useCallback((message: string) => {
    setAnnouncement((previous) => ({ message, seq: previous.seq + 1 }));
  }, []);
  return { announcement, announce };
}
