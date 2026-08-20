import { Effect } from 'effect';

import type { PtyBackendCatalogService } from './backend.js';
import type { PtyRetryScheduler } from './service/retry.js';
import type { PtyBackendName, PtyBackend as PtyBackendShape } from './types.js';

/**
 * Test-only catalog. Every field is explicit on purpose: a cross-backend test
 * has to state its launch preference and both registered adapters, so a test
 * can never silently pass because the helper defaulted the very thing under
 * test. The internal registry mirrors production, so a widened
 * `PtyBackendName` breaks here first and adding the required parameter then
 * forces every call site to state the new adapter too.
 */
export function fakeBackendCatalog(input: {
  readonly configured: PtyBackendName;
  readonly nodePty: PtyBackendShape;
  readonly tmux: PtyBackendShape;
}): PtyBackendCatalogService {
  const backends = {
    node_pty: input.nodePty,
    tmux: input.tmux,
  } satisfies Record<PtyBackendName, PtyBackendShape>;
  return {
    configured: backends[input.configured],
    forBackend: (name) => {
      if (!Object.hasOwn(backends, name)) {
        throw new Error(`Unknown persisted PTY backend ${String(name)}.`);
      }
      return backends[name];
    },
    all: Object.values(backends),
  };
}

/**
 * Test-only retry scheduler. Deferred terminal writes are the riskiest part of
 * the termination lifecycle, so tests must be able to advance failure → success
 * deterministically instead of waiting on wall-clock timers — and must be able
 * to assert that a resolved retry left no further work behind.
 */
export interface ManualPtyRetryScheduler extends PtyRetryScheduler {
  readonly pendingCount: () => number;
  // Runs the jobs scheduled so far. A job that fails again re-schedules itself,
  // which lands in the queue for the next `runPending`, so a test spells out how
  // many attempts it is granting.
  readonly runPending: Effect.Effect<void>;
}

export function manualPtyRetryScheduler(): ManualPtyRetryScheduler {
  let pending: Effect.Effect<void>[] = [];
  let stopped = false;
  return {
    schedule: (_label, job) => {
      if (stopped) return;
      pending.push(job);
    },
    // Mirrors the real scheduler's policy: queued work gets its attempt while
    // dependencies are still up, and anything it re-queues after that is
    // refused.
    shutdown: Effect.suspend(() => {
      stopped = true;
      const jobs = pending;
      pending = [];
      return Effect.forEach(jobs, (job) => job, { discard: true });
    }),
    pendingCount: () => pending.length,
    runPending: Effect.suspend(() => {
      const jobs = pending;
      pending = [];
      return Effect.forEach(jobs, (job) => job, { discard: true });
    }),
  };
}
