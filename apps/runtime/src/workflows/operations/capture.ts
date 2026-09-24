import type {
  WorkflowAgentHarness,
  HeadlessOperationResult,
} from '@yourtechbudstudio/isagi-workflow-sdk';
import { Cause, Effect, Fiber, type Scope } from 'effect';

import type { WorkflowOperationsRepositoryService } from '../persistence/operations.repository.js';
import type { WorkflowOperationRecord } from '../persistence/records.js';
import type { OperationAdapters } from './adapters/types.js';
import { isSettled } from './correlation.js';
import type { OperationSettlement } from './settlement.js';
import type { OperationStopPolicy } from './stop.js';

/**
 * Result capture: the half of an operation's life that belongs to the runtime rather than to a
 * callback.
 *
 * A submitted headless operation outlives the attempt that launched it, so its tracker and its
 * timeout are owned by the incarnation's scope. The maps here are acceleration only — every question
 * they answer is also answerable from the durable rows, which is what makes recovery after a restart
 * the same code path as recovery after a retry.
 */
type TrackedCapture = {
  readonly operationId: number;
  readonly operationKey: string;
  readonly runId: number;
  readonly ptyProcessId: number;
  readonly harness: WorkflowAgentHarness;
  readonly launchedAt: string;
  /**
   * The fiber waiting out this operation's timeout, owned by the incarnation's scope.
   *
   * Deliberately not a `setTimeout` handle. A raw timer whose callback starts an unowned root fiber
   * outlives layer shutdown even after the timer is cleared, so a settlement could land against a
   * torn-down runtime. Service-owned has to mean scoped, not merely "not the attempt's".
   */
  timer: Fiber.RuntimeFiber<void, never> | null;
};

export type CaptureTerminal =
  | { readonly kind: 'exited'; readonly exitCode: number | null }
  | { readonly kind: 'failed' }
  | { readonly kind: 'killed' }
  | { readonly kind: 'timeout' };

export interface CaptureRegistry {
  readonly track: (input: {
    readonly record: WorkflowOperationRecord;
    readonly harness: WorkflowAgentHarness;
    readonly ptyProcessId: number;
    readonly timeoutMs: number;
    readonly launchedAt: string;
  }) => Effect.Effect<void, never>;
  /** Handles a process terminal, whether or not this incarnation is the one capturing it. */
  readonly onProcessTerminal: (input: {
    readonly ptyProcessId: number;
    readonly terminal: CaptureTerminal;
  }) => Effect.Effect<void, never>;
  readonly clear: Effect.Effect<void, never>;
}

export function makeCaptureRegistry(dependencies: {
  readonly operations: WorkflowOperationsRepositoryService;
  readonly adapters: OperationAdapters;
  readonly settlement: OperationSettlement;
  readonly stop: OperationStopPolicy;
  readonly incarnationScope: Scope.Scope;
}): CaptureRegistry {
  const { operations, adapters, incarnationScope } = dependencies;
  const { settle, retainLateEvidence, headlessReceiptOf } = dependencies.settlement;
  const { requestStop } = dependencies.stop;

  const die = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A, never> =>
    effect.pipe(Effect.orDie);

  const captures = new Map<number, TrackedCapture>();
  const captureByPtyProcessId = new Map<number, number>();

  const untrack = (operationId: number) =>
    Effect.gen(function* () {
      const tracked = captures.get(operationId);
      if (!tracked) return;
      captures.delete(operationId);
      captureByPtyProcessId.delete(tracked.ptyProcessId);
      if (tracked.timer) yield* Fiber.interrupt(tracked.timer);
    });

  /**
   * Settle an operation and announce it.
   *
   * Publication happens after the commit, always: a notification that arrives before the row it
   * describes would let a resolver read a state that does not exist yet.
   */

  const captureResult = (input: {
    readonly record: WorkflowOperationRecord;
    readonly harness: WorkflowAgentHarness;
    readonly ptyProcessId: number;
    readonly terminal:
      | { readonly kind: 'exited'; readonly exitCode: number | null }
      | { readonly kind: 'failed' }
      | { readonly kind: 'killed' }
      | { readonly kind: 'timeout' };
  }) =>
    Effect.gen(function* () {
      const captured = yield* adapters.headless
        .capture({ ptyProcessId: input.ptyProcessId, harness: input.harness })
        .pipe(Effect.orElseSucceed(() => ({ raw: '', output: '' })));
      const semanticError = adapters.headless.semanticError({
        harness: input.harness,
        raw: captured.raw,
      });
      const exitCode = input.terminal.kind === 'exited' ? input.terminal.exitCode : null;
      const succeeded =
        input.terminal.kind === 'exited' && exitCode === 0 && semanticError === null;
      const error = succeeded
        ? undefined
        : (semanticError ??
          (input.terminal.kind === 'killed'
            ? 'killed'
            : input.terminal.kind === 'failed'
              ? 'process_failed'
              : input.terminal.kind === 'timeout'
                ? 'timeout'
                : 'non_zero_exit'));
      const result: HeadlessOperationResult = {
        operationId: input.record.operationKey,
        status: succeeded ? 'completed' : 'failed',
        output: captured.output,
        ...(error === undefined ? {} : { error }),
        exitCode,
      };
      // Read from the same captured bytes the result came from, so provenance describes exactly the
      // run being settled. A failed or timed-out run is read too: a process that died after
      // reporting its session id and usage still told us those facts, and discarding them would
      // lose provenance precisely for the runs a postmortem cares about most.
      const provenance = adapters.headless.headlessProvenance({
        harness: input.harness,
        raw: captured.raw,
      });
      return { result, provenance };
    });

  const settleFromTerminal = (input: {
    readonly tracked: TrackedCapture;
    readonly terminal: Parameters<typeof captureResult>[0]['terminal'];
  }) =>
    Effect.gen(function* () {
      const record = yield* die(operations.findById(input.tracked.operationId));
      if (!record) {
        yield* untrack(input.tracked.operationId);
        return;
      }
      const { result, provenance } = yield* captureResult({
        record,
        harness: input.tracked.harness,
        ptyProcessId: input.tracked.ptyProcessId,
        terminal: input.terminal,
      });

      if (isSettled(record.state)) {
        // Cleanup happens whatever the retention does. A failure to record evidence must not leave
        // this process pinned or this operation tracked, which would be a capture ownership the
        // runtime no longer has any intention of honouring.
        yield* adapters.headless.unpin(input.tracked.ptyProcessId).pipe(Effect.ignore);
        yield* retainLateEvidence({ record, result });
        yield* untrack(input.tracked.operationId);
        return;
      }

      yield* adapters.headless.unpin(input.tracked.ptyProcessId).pipe(Effect.ignore);
      yield* settle({
        record,
        state: result.status === 'completed' ? 'completed' : 'failed',
        result,
        // A headless row's correlated session id is written at settlement while its `attribution`
        // stays `not_applicable`, and that is accurate: the provider *told* us the id, so nothing
        // was inferred by watermark. Attribution describes how a turn was matched, not whether one
        // is known.
        provenance: {
          correlatedHarnessSessionId: provenance.harnessSessionId,
          usage: provenance.usage,
        },
      });
      yield* untrack(input.tracked.operationId);
    });

  /**
   * A terminal for a process this incarnation is not capturing.
   *
   * Read-only about ownership: it never settles, because settling would mean claiming a result
   * nobody here watched being produced. An operation still unsettled is left to reconciliation,
   * which is the path that has the evidence rules.
   */

  const retainForeignTerminal = (input: {
    readonly ptyProcessId: number;
    readonly terminal: Parameters<typeof captureResult>[0]['terminal'];
  }) =>
    Effect.gen(function* () {
      const record = yield* die(operations.findByPtyProcessId(input.ptyProcessId));
      if (!record || !isSettled(record.state)) return;
      const parsed = yield* headlessReceiptOf(record);
      if (!parsed) return;
      const { result } = yield* captureResult({
        record,
        harness: parsed.harness,
        ptyProcessId: input.ptyProcessId,
        terminal: input.terminal,
      });
      // No provenance is written here: this operation is already settled, and provenance about a
      // finished run is not grounds to reopen it. What the process finally did is retained as late
      // evidence, which is the channel that never rewrites an outcome.
      yield* retainLateEvidence({ record, result });
    });

  /**
   * Keep what a surviving process finally did, without letting it rewrite the outcome.
   *
   * This is the only record of what an agent the runtime lost track of actually produced in the
   * person's worktree. Rejecting the revival and discarding the evidence would answer the safety
   * question and throw away the diagnostic one.
   */

  const trackCapture = (input: {
    readonly record: WorkflowOperationRecord;
    readonly harness: WorkflowAgentHarness;
    readonly ptyProcessId: number;
    readonly timeoutMs: number;
    readonly launchedAt: string;
  }) =>
    Effect.gen(function* () {
      const tracked: TrackedCapture = {
        operationId: input.record.id,
        operationKey: input.record.operationKey,
        runId: input.record.runId,
        ptyProcessId: input.ptyProcessId,
        harness: input.harness,
        launchedAt: input.launchedAt,
        timer: null,
      };
      captures.set(input.record.id, tracked);
      captureByPtyProcessId.set(input.ptyProcessId, input.record.id);
      // Forked into the *incarnation's* scope, not the caller's: the capture has to outlive the
      // callback that started it, and it has to end when the runtime does. Shutdown interrupts
      // this fiber, so a timeout cannot fire against a runtime that has already torn down.
      tracked.timer = yield* Effect.forkIn(
        Effect.gen(function* () {
          yield* Effect.sleep(`${input.timeoutMs} millis`);
          // Stop first, then record. The process is by definition still running at a timeout, so
          // the stop is part of reaching the outcome rather than tidying up after it — and routing
          // it through `requestStop` means a timed-out operation reports its stop completeness the
          // same way every other stopped operation does, instead of terminating silently.
          const current = yield* die(operations.findById(tracked.operationId));
          if (current && !isSettled(current.state)) {
            yield* requestStop(current, 'headless_timeout');
          }
          yield* settleFromTerminal({ tracked, terminal: { kind: 'timeout' } });
        }).pipe(
          Effect.catchAllCause((cause) =>
            Effect.sync(() => {
              if (Cause.isInterruptedOnly(cause)) return;
              console.warn('[runtime] Headless workflow timeout handling failed', cause);
            }),
          ),
        ),
        incarnationScope,
      );
    });

  // ---- recovery ---------------------------------------------------------

  return {
    track: trackCapture,
    onProcessTerminal: (input) =>
      Effect.gen(function* () {
        const operationId = captureByPtyProcessId.get(input.ptyProcessId);
        const tracked = operationId === undefined ? undefined : captures.get(operationId);
        if (tracked) {
          yield* settleFromTerminal({ tracked, terminal: input.terminal });
          return;
        }
        // Nothing here is capturing this process, so it belongs to an incarnation that ended. The
        // durable record still knows whose it was, and what it finally did is the only account of
        // what that agent left behind — kept as evidence, never as an adoption of a capture lifetime
        // this runtime deliberately did not inherit.
        yield* retainForeignTerminal(input);
      }),
    // The timeout fibers are already owned by the incarnation scope and are interrupted by its
    // closing; this only drops the acceleration maps, which hold no lifetime of their own.
    clear: Effect.sync(() => {
      captures.clear();
      captureByPtyProcessId.clear();
    }),
  };
}
