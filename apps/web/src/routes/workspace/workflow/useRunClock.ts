import { useEffect, useState } from 'react';

/**
 * One second-hand for the whole inspector, and only while something is genuinely open.
 *
 * Elapsed time is information, not decoration: a person watching a step that has been waiting four
 * minutes needs the number to move. But it is *display* only — nothing here polls the runtime, and
 * every fact the clock is applied to came from a recorded instant. When nothing is open, or the
 * window is not being looked at, the timer stops rather than re-rendering a run that has ended.
 *
 * Deliberately not gated on reduced motion. That setting is about movement, and a stale elapsed time
 * would be a worse answer, not a calmer one.
 */
export function useRunClock(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!live) return;
    const tick = () => setNow(Date.now());
    tick();

    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer === null) timer = setInterval(tick, 1000);
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        // Catch up immediately: a tab that comes back to a five-minute-old number has been lying
        // about it for five minutes.
        tick();
        start();
      } else {
        stop();
      }
    };

    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [live]);

  return now;
}
