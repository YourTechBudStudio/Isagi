import type { Announcement } from '../hooks/useAnnouncement.js';

/**
 * A polite live region that re-arms itself between announcements.
 *
 * Two regions alternate by sequence parity, so consecutive identical messages
 * still mutate text: the message moves from one region to the other, and the
 * receiving region changes from empty to the message. A single region would be
 * silent on a repeat, because setting React state to the value it already holds
 * produces no DOM change at all — and a copy that confirms visibly for the
 * second time would confirm to nobody using a screen reader.
 */
export function LiveAnnouncement({ announcement }: { readonly announcement: Announcement }) {
  const inSecond = announcement.seq % 2 === 1;
  return (
    <>
      <span aria-live="polite" className="sr-only">
        {inSecond ? '' : announcement.message}
      </span>
      <span aria-live="polite" className="sr-only">
        {inSecond ? announcement.message : ''}
      </span>
    </>
  );
}
