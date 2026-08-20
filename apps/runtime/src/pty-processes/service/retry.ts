import { Effect } from 'effect';

// Persistence retries outlive the call that scheduled them, so they need an
// owner. This is that owner: every deferred terminal write is scheduled here,
// and the PTY service scope shuts the scheduler down while the repository is
// still open — so a queued write gets one last attempt against a live database,
// and anything still unresolved after that is abandoned loudly rather than left
// writing into a torn-down runtime.
export interface PtyRetryScheduler {
  // `job` must handle its own failures; a job that wants another attempt
  // schedules itself again from inside its failure branch.
  readonly schedule: (label: string, job: Effect.Effect<void>) => void;
  // Stops accepting new work, runs what is queued without waiting out its delay,
  // and waits for everything in flight.
  readonly shutdown: Effect.Effect<void>;
}

interface QueuedRetry {
  readonly label: string;
  readonly job: Effect.Effect<void>;
}

const retryDelayMs = 1_000;

export function makePtyRetryScheduler(
  options: { readonly delayMs?: number | undefined } = {},
): PtyRetryScheduler {
  const delayMs = options.delayMs ?? retryDelayMs;
  const queued = new Map<NodeJS.Timeout, QueuedRetry>();
  const running = new Set<Promise<void>>();
  let stopped = false;

  const start = (job: Effect.Effect<void>) => {
    const promise = Effect.runPromise(job);
    running.add(promise);
    void promise.finally(() => running.delete(promise));
  };

  const schedule = (label: string, job: Effect.Effect<void>) => {
    if (stopped) {
      // Past shutdown there is nobody left to serve another attempt: the
      // reservation this retry was holding dies with the runtime and the row
      // stays whatever it last durably was. Say so rather than leaving a silent
      // gap between the kill and the record.
      console.warn(`[runtime] Abandoning PTY persistence retry after shutdown ${label}`);
      return;
    }
    const timer = setTimeout(() => {
      queued.delete(timer);
      start(job);
    }, delayMs);
    timer.unref();
    queued.set(timer, { label, job });
  };

  return {
    schedule,
    shutdown: Effect.promise(async () => {
      // Set first, so a job that fails during the drain is refused another
      // attempt — and logs its abandonment — instead of queueing work nobody
      // will ever run.
      stopped = true;
      const pending = [...queued.entries()];
      queued.clear();
      for (const [timer, retry] of pending) {
        clearTimeout(timer);
        // The delay was only ever backoff. The database is still open right now,
        // so a queued terminal write gets its attempt here rather than being
        // dropped for having been scheduled a moment too late.
        console.info(`[runtime] Draining queued PTY persistence retry ${retry.label}`);
        start(retry.job);
      }
      // In-flight jobs are mid-write against a repository that is still open;
      // draining them here is what keeps the write out of a closed database.
      await Promise.allSettled([...running]);
    }),
  };
}
