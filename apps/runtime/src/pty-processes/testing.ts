import { Effect, Exit } from 'effect';

import { resolveRegisteredBackend, type PtyBackendCatalog } from './backend.js';
import type { PtyService } from './service.js';
import type { PtyPersistenceRetry } from './service/retry.js';
import { terminatePtyProcesses } from './service/termination.js';
import type {
  PtyBackendName,
  PtyProcessAllocation,
  PtyProcessLaunchMetadata,
  PtyBackend as PtyBackendShape,
} from './types.js';

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
}): PtyBackendCatalog['Service'] {
  const backends = {
    node_pty: input.nodePty,
    tmux: input.tmux,
  } satisfies Record<PtyBackendName, PtyBackendShape>;
  return {
    configured: backends[input.configured],
    forBackend: (name) => resolveRegisteredBackend(backends, name),
    all: Object.values(backends),
  };
}

/**
 * Test-only persistence retry. Deferred terminal writes are the riskiest part of
 * the termination lifecycle, so tests must be able to advance failure → success
 * deterministically instead of waiting out a backoff — and must be able to
 * assert that a resolved retry left no further work behind.
 */
export interface ManualPtyPersistenceRetry extends PtyPersistenceRetry {
  readonly pendingCount: () => number;
  // Gives every submitted retry one attempt. An attempt that fails again stays
  // pending for the next `runPending`, as the real retry keeps trying, so a test
  // spells out how many attempts it is granting.
  readonly runPending: Effect.Effect<void>;
}

export function manualPtyPersistenceRetry(): ManualPtyPersistenceRetry {
  let pending: Effect.Effect<void, unknown>[] = [];
  return {
    submit: (_label, attempt) =>
      Effect.sync(() => {
        pending.push(attempt);
      }),
    pendingCount: () => pending.length,
    runPending: Effect.suspend(() => {
      const attempts = pending;
      pending = [];
      return Effect.forEach(
        attempts,
        (attempt) =>
          Effect.exit(attempt).pipe(
            Effect.map((exit) => {
              if (Exit.isFailure(exit)) pending.push(attempt);
            }),
          ),
        { discard: true },
      );
    }),
  };
}

/**
 * Test-only PTY launch allocation. Tests supply what `start` should do; the
 * one-shot state machine is enforced here so a fake can never be more
 * permissive than production and let a caller start twice, or abandon a
 * launch that is already running, without the test noticing.
 */
export function fakePtyAllocation(input: {
  readonly ptyProcessId: number;
  readonly start: Effect.Effect<PtyProcessLaunchMetadata>;
  readonly onAbandon?: (() => void) | undefined;
}): PtyProcessAllocation {
  let phase: 'allocated' | 'starting' | 'settled' | 'abandoned' = 'allocated';
  return {
    ptyProcessId: input.ptyProcessId,
    start: Effect.suspend(() => {
      if (phase !== 'allocated') {
        return Effect.die(
          new Error(
            `Fake PTY launch allocation ${input.ptyProcessId} cannot be started from phase ${phase}.`,
          ),
        );
      }
      phase = 'starting';
      return input.start.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            phase = 'settled';
          }),
        ),
      );
    }),
    abandon: Effect.suspend(() => {
      if (phase !== 'allocated') return Effect.void;
      phase = 'abandoned';
      return Effect.sync(() => input.onAbandon?.());
    }),
  };
}

/**
 * The repository, its owner discovery and the GC pass, for the cross-module ownership test in
 * `app/tests/pty-gc-ownership.test.ts`: only there can owner rows from other modules be seeded.
 */
export { PtyBackendCatalog } from './backend.js';
export { PtyRepository, ptyProcessOwnerColumns } from './repository.js';
export { collectPtyGarbage } from './service/gc.js';

/**
 * `terminateMany` for a fake `PtyService`: the production fan-out (concurrency, logging, failure
 * policy) over the fake's own `terminate`, so a test that records or fails `terminate` observes
 * multi-process teardown exactly as the real service performs it.
 */
export function fakeTerminateMany(
  terminate: PtyService['Service']['terminate'],
): PtyService['Service']['terminateMany'] {
  return (input) => terminatePtyProcesses(terminate, input);
}

// Internals and builders other modules' tests use; never imported by production code.
export type { PtyAttachment } from './service.js';
export { decodeBackendRef } from './service/backend-ref.js';
export { isTerminalPtyProcessStatus } from './types.js';
export type { PtyBackendName, PtyProcessLaunchMetadata } from './types.js';
