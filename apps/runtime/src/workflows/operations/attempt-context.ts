import { createHash } from 'node:crypto';

import type {
  AgentSessionHandle,
  AgentTurnTarget,
  HeadlessOperationHandle,
  HeadlessOperationResult,
  OperationContext,
  WorkflowAgentHarness,
  WorkflowConversationMessage,
  WorkflowDestination,
  WorkflowHeadlessAgentInput,
  WorkflowLogLevel,
  WorkflowUiFeedback,
} from '@yourtechbudstudio/isagi-workflow-sdk';
import { Cause, Effect, Exit, Fiber, Option } from 'effect';

import type {
  WorkflowCapability,
  WorkflowDiagnosticDetail,
  WorkflowInvocationKind,
} from '@isagi/contracts';

import type { WorkflowOperationsRepositoryService } from '../persistence/operations.repository.js';
import type { WorkflowOperationRecord } from '../persistence/records.js';
import {
  isTerminalRunStatus,
  type WorkflowRunsRepositoryService,
} from '../persistence/runs.repository.js';
import { renderWorkflowPromptEffect } from '../prompt-renderer.js';
import { canonicalJson } from '../state/serializable.js';
import type { AttemptTurnRecovery } from '../waits/turn-recovery.js';
import type { OperationAdapters } from './adapters/types.js';
import type { CaptureRegistry } from './capture.js';
import { classifySubmissionEvidence } from './classify.js';
import {
  decidePrefix,
  requestEnvelope,
  type NormalizedRequest,
  type OperationRequestEnvelope,
} from './correlation.js';
import { OperationRejection } from './errors.js';
import { readAgentTurnReceipt, readSpawnSessionReceipt, type HeadlessReceipt } from './receipts.js';
import type { OperationReconciler } from './reconcile.js';
import type { OperationSettlement } from './settlement.js';
import type { OperationStopPolicy } from './stop.js';

export const defaultHeadlessTimeoutMs = 10 * 60_000;

/**
 * How long a masked write-and-confirm may take before it is worth saying so.
 *
 * Not a timeout and not a claim about the region's length — interruption stays masked either way.
 * It exists so a shutdown delayed by a stalled PTY write or a stalled commit is diagnosable rather
 * than silent.
 */
const maskedSubmissionWarnMs = 2_000;

/** Everything one callback invocation needs to attribute its operations to durable identities. */
export interface OperationAttemptIdentity {
  readonly runId: number;
  readonly frameId: number;
  readonly executionId: number;
  readonly attemptId: number;
  /** 1-based attempt index, surfaced to authors through `ctx.invocation.attempt`. */
  readonly attemptIndex: number;
  readonly invocationKind: WorkflowInvocationKind;
  readonly artifactHash: string;
  readonly agentTurnRecovery?: AttemptTurnRecovery | null | undefined;
  readonly destination: WorkflowDestination;
}

/**
 * What a completed callback leaves behind for the interpreter's return validation.
 *
 * The counts are separate facts. `consumed` is how far this invocation walked; `recorded` is how far
 * some earlier invocation got. A callback that deleted an effect call returns the first smaller than
 * the second, which is `operation_prefix_unconsumed` — work quietly abandoned rather than accounted
 * for. Phase 04 owns turning that into a segment failure; this layer only reports it honestly.
 */
export interface AttemptContextOutcome<A> {
  readonly value: A;
  readonly consumedCallCount: number;
  readonly recordedCallCount: number;
}

export type WithAttemptContext = <A, E, R>(
  identity: OperationAttemptIdentity,
  use: (context: OperationContext) => Effect.Effect<A, E, R>,
) => Effect.Effect<AttemptContextOutcome<A>, E, R>;

/**
 * Builds the `ctx` an author callback is handed, and the durable bookkeeping behind every verb.
 *
 * One place decides what is written before which boundary. The adapters underneath own owner calls
 * and no ordering; the reconciler and capture registry own what happens when nobody is holding the
 * call. This module owns only the live path: claim a position, cross the boundary, record the
 * receipt.
 */
export function makeAttemptContextFactory(dependencies: {
  readonly operations: WorkflowOperationsRepositoryService;
  readonly runs: WorkflowRunsRepositoryService;
  readonly adapters: OperationAdapters;
  readonly settlement: OperationSettlement;
  readonly reconciler: OperationReconciler;
  readonly captures: CaptureRegistry;
  readonly stop: OperationStopPolicy;
  readonly incarnationId: string;
  readonly now: () => string;
}): WithAttemptContext {
  const { operations, runs, adapters, captures, incarnationId, now } = dependencies;
  const { advanceStage, receipt, envelopeOf, settle } = dependencies.settlement;
  const { reconcileSubmission } = dependencies.reconciler;
  const { requestStop } = dependencies.stop;

  const die = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A, never> =>
    effect.pipe(Effect.orDie);

  const fingerprint = (request: NormalizedRequest) =>
    createHash('sha256').update(canonicalJson(request), 'utf8').digest('hex');

  const withAttemptContext = <A, E, R>(
    identity: OperationAttemptIdentity,
    use: (context: OperationContext) => Effect.Effect<A, E, R>,
  ): Effect.Effect<AttemptContextOutcome<A>, E, R> =>
    // A real scope, not a flag. Every verb's work is forked *into* it, so closing it — when the
    // callback returns, or when the runtime shuts down — interrupts work still in flight instead
    // of leaving a detached fiber polling a PTY nobody is waiting for any more.
    Effect.scopedWith((attemptScope) =>
      Effect.gen(function* () {
        const gate = yield* Effect.makeSemaphore(1);
        const conversationGate = yield* Effect.makeSemaphore(1);
        const state = { nextCallIndex: 0, consumed: 0, closed: false };
        let recoveredConversation: readonly WorkflowConversationMessage[] | null = null;

        const reject = (
          input: ConstructorParameters<typeof OperationRejection>[0],
        ): Effect.Effect<never, OperationRejection> => Effect.fail(new OperationRejection(input));

        /**
         * Allocate a call position and decide what may happen at it.
         *
         * Serialized, and the durable prefix is re-read *inside* the lock rather than captured
         * outside it: an earlier call can become uncertain while this one is queued, and a decision
         * made from a stale read would add an effect on top of a delivery nobody can establish.
         * Dispatch itself runs outside the lock, so two headless launches still overlap.
         */
        const claimPosition = (input: {
          readonly capability: WorkflowCapability;
          readonly request: NormalizedRequest;
          readonly dispatch?: OperationRequestEnvelope['dispatch'] | undefined;
          readonly metadata?: OperationRequestEnvelope['metadata'] | undefined;
        }) =>
          gate.withPermits(1)(
            Effect.gen(function* () {
              if (state.closed) {
                return yield* reject({
                  code: 'operation_context_closed',
                  message: `Operation context for attempt ${identity.attemptId} is closed; the segment it belonged to has already finished.`,
                });
              }
              const callIndex = state.nextCallIndex;
              state.nextCallIndex += 1;
              state.consumed = Math.max(state.consumed, callIndex + 1);

              const identityHash = fingerprint(input.request);
              const recorded = yield* die(operations.listForExecution(identity.executionId));
              const decision = decidePrefix({
                callIndex,
                capability: input.capability,
                fingerprint: identityHash,
                recorded,
              });

              switch (decision.kind) {
                case 'prefix_unresolved':
                  return yield* reject({
                    code: 'operation_prefix_unresolved',
                    message: `Call ${callIndex} cannot run while operation ${decision.blocking.operationKey} at call ${decision.blocking.callIndex} remains uncertain.`,
                    operationId: decision.blocking.id,
                  });
                case 'uncertain':
                  return yield* reject({
                    code: 'operation_uncertain',
                    message: `Operation ${decision.blocking.operationKey} at call ${callIndex} has an unestablished outcome and cannot be retried or resent.`,
                    operationId: decision.blocking.id,
                    detail: { uncertaintyDetail: decision.blocking.uncertaintyDetail },
                  });
                case 'request_changed':
                  return yield* reject({
                    code: 'operation_request_changed',
                    message: `Call ${callIndex} was recorded as a different ${decision.existing.capability} request; an incompatible recovery request is refused before any new effect.`,
                    operationId: decision.existing.id,
                    detail: {
                      recordedFingerprint: decision.recordedFingerprint,
                      requestedFingerprint: identityHash,
                    },
                  });
                case 'reuse':
                  return { kind: 'reuse' as const, record: decision.existing };
                case 'dispatch': {
                  // Idempotent on the call position: an adopted `intended` or `abandoned` row keeps
                  // its operation key, which is what makes a redispatch the *same* operation.
                  const written = yield* die(
                    operations.recordIntent({
                      runId: identity.runId,
                      frameId: identity.frameId,
                      executionId: identity.executionId,
                      originAttemptId: identity.attemptId,
                      capability: input.capability,
                      callIndex,
                      request: {
                        value: requestEnvelope({
                          request: input.request,
                          ...(input.dispatch ? { dispatch: input.dispatch } : {}),
                          ...(input.metadata ? { metadata: input.metadata } : {}),
                        }),
                      },
                      fingerprintOf: { value: input.request },
                      artifactHash: identity.artifactHash,
                    }),
                  );
                  if (!written.ok) {
                    // Cancel revoked permission to cross a new boundary. Reported as its own code
                    // rather than folded into "changed request": the author did nothing wrong, and
                    // the two call for different explanations.
                    if (written.rejection.kind === 'run_terminal') {
                      return yield* reject({
                        code: 'workflow_run_cancelled',
                        message: `Call ${callIndex} cannot start new external work: run ${identity.runId} is ${written.rejection.status}.`,
                        detail: { status: written.rejection.status },
                      });
                    }
                    return yield* reject({
                      code: 'operation_request_changed',
                      message: `Call ${callIndex} could not record its intent: ${written.rejection.kind}.`,
                      detail: { rejection: written.rejection },
                    });
                  }
                  return { kind: 'dispatch' as const, record: written.value };
                }
              }
            }),
          );

        /**
         * Refuse to cross a new external boundary on a run that has been cancelled.
         *
         * The intent transaction already refuses to *record* a new call position after Cancel, but
         * real work happens between that write and the boundary it precedes — waiting for an
         * observer, quiescence, a pane and session, a process allocation. Cancel landing in that gap
         * has to stop the crossing too, which is why the design asks for the check immediately
         * before it rather than once at the start.
         *
         * Every call site is placed so that a refusal leaves a state the recovery rules already read
         * as "nothing crossed": before a `*_submitting` marker rather than after it, and before the
         * `starting` marker rather than after it. Refusing *after* one of those markers would leave
         * an operation that looks indeterminate and would block the run — Cancel manufacturing
         * uncertainty out of an orderly stop.
         *
         * The race after this check is real and is not claimed away: an effect already crossing is
         * recorded and answered for by the stop protocol.
         */
        const assertDispatchable = (boundary: string) =>
          Effect.gen(function* () {
            const run = yield* die(runs.findRun(identity.runId));
            if (!run) {
              return yield* reject({
                code: 'workflow_run_cancelled',
                message: `Run ${identity.runId} no longer exists; refusing to ${boundary}.`,
              });
            }
            if (run.cancelRequested || isTerminalRunStatus(run.status)) {
              return yield* reject({
                code: 'workflow_run_cancelled',
                message: `Run ${identity.runId} is ${run.status}; refusing to ${boundary}.`,
                detail: { status: run.status, boundary },
              });
            }
          });

        const appendDiagnostic = (kind: 'log' | 'ui_feedback', detail: WorkflowDiagnosticDetail) =>
          Effect.gen(function* () {
            if (state.closed) {
              return yield* reject({
                code: 'operation_context_closed',
                message: `Operation context for attempt ${identity.attemptId} is closed; diagnostics cannot be appended to a finished segment.`,
              });
            }
            // Correlated to the attempt that wrote it, and consuming no call position: a diagnostic
            // may legitimately repeat under a different attempt, and must never shift an effect's
            // recorded index when an author adds one.
            const written = yield* die(
              runs.appendDiagnostic({
                runId: identity.runId,
                kind,
                detail: { value: detail },
                frameId: identity.frameId,
                executionId: identity.executionId,
                attemptId: identity.attemptId,
              }),
            );
            if (!written.ok) {
              // Propagated, not swallowed. A diagnostic that silently vanishes is worse than a
              // visible failure, and this one is inside a retryable segment.
              return yield* reject({
                code: 'workflow_operation_failed',
                message: `Workflow diagnostic could not be recorded: ${written.rejection.kind}.`,
                detail: { rejection: written.rejection },
              });
            }
          });

        // -- durable capability bodies ---------------------------------------

        const performSend = (input: {
          readonly record: WorkflowOperationRecord;
          readonly agentSessionId: number;
          readonly renderedPrompt: string;
        }) =>
          Effect.gen(function* () {
            const prepared = yield* adapters.agentSessions.prepareSend({
              agentSessionId: input.agentSessionId,
            });
            yield* assertDispatchable('send a prompt');
            const watermark = now();
            // Every input recovery needs, persisted *before* the write it describes. Reading the
            // operation's creation timestamp instead would not do: it precedes the quiescence wait
            // and the active-process lookup, so it would admit turns that started before this prompt
            // could possibly have been sent.
            yield* advanceStage({
              operationId: input.record.id,
              stage: 'submitting',
              state: 'dispatched',
              targetKind: 'agent_session',
              targetId: prepared.agentSessionId,
              ptyProcessId: prepared.ptyProcessId,
              submissionWatermark: watermark,
            });
            yield* submitUninterruptibly(
              'send_agent_prompt',
              Effect.gen(function* () {
                yield* adapters.agentSessions.submitPrompt({
                  ptyProcessId: prepared.ptyProcessId,
                  text: input.renderedPrompt,
                });
                yield* advanceStage({
                  operationId: input.record.id,
                  stage: 'submitted',
                  state: 'dispatched',
                  receipt: {
                    value: { agentSessionId: prepared.agentSessionId, sentAt: watermark },
                  },
                });
              }),
            );
            return { agentSessionId: prepared.agentSessionId, sentAt: watermark };
          });

        /**
         * Decide what a re-entered PTY-crossing call position may hand back.
         *
         * The generic "a `dispatched` operation returns its saved receipt" rule cannot serve this
         * capability class unrefined. Two stages look settled and are not: a `*_submitting` row has
         * nothing confirming its write, and a `session_created` row has resources but no prompt. So
         * this answers `usable` only for a confirmed submission, `resume` when the operation must
         * continue from where it stopped, and rejects when evidence cannot establish the outcome.
         */
        const reuseSubmission = (record: WorkflowOperationRecord) =>
          Effect.gen(function* () {
            const evidence = classifySubmissionEvidence(record);
            let current = record;
            if (evidence.kind === 'reconcile_from_ledger') {
              yield* reconcileSubmission(record);
              current = (yield* die(operations.findById(record.id))) ?? record;
            }
            if (current.state === 'uncertain') {
              return yield* reject({
                code: 'operation_uncertain',
                message: `Operation ${current.operationKey} crossed a PTY boundary whose outcome cannot be established; it will not be resent.`,
                operationId: current.id,
                detail: { uncertaintyDetail: current.uncertaintyDetail },
              });
            }
            return classifySubmissionEvidence(current).kind === 'submitted'
              ? ({ kind: 'usable', record: current } as const)
              : ({ kind: 'resume', record: current } as const);
          });

        const performSpawn = (input: {
          readonly record: WorkflowOperationRecord;
          readonly harness: WorkflowAgentHarness;
          readonly model?: string | undefined;
          readonly effort?: string | undefined;
          readonly renderedPrompt: string;
        }) =>
          Effect.gen(function* () {
            const destination = identity.destination;
            const submission = classifySubmissionEvidence(input.record);
            // Creating the compound is itself an external mutation — a pane and a session the person
            // will see — so it is fenced like any other boundary.
            yield* assertDispatchable('create an agent session');
            // Resources first, and recorded as soon as the owner returns them. Re-entry adopts them
            // through the same keyed call rather than creating a second pane or session.
            const created = yield* adapters.agentSessions.createKeyedSession({
              creationKey: input.record.operationKey,
              worktreeId: destination.worktreeId,
              surfaceId: destination.surfaceId,
              harness: input.harness,
            });
            if (submission.kind === 'never_submitted') {
              yield* advanceStage({
                operationId: input.record.id,
                stage: 'session_created',
                state: 'dispatched',
                targetKind: 'agent_session',
                targetId: created.agentSessionId,
                receipt: {
                  value: {
                    agentSessionId: created.agentSessionId,
                    surfaceId: created.surfaceId,
                    paneId: created.paneId,
                    sentAt: '',
                  },
                },
              });
            }
            const prepared = yield* adapters.agentSessions.prepareSeed({
              agentSessionId: created.agentSessionId,
              model: input.model,
              effort: input.effort,
            });
            yield* assertDispatchable('seed an agent session');
            const watermark = now();
            yield* advanceStage({
              operationId: input.record.id,
              stage: 'seed_submitting',
              state: 'dispatched',
              targetKind: 'agent_session',
              targetId: created.agentSessionId,
              ptyProcessId: prepared.ptyProcessId,
              submissionWatermark: watermark,
            });
            yield* submitUninterruptibly(
              'spawn_agent_session.seed',
              Effect.gen(function* () {
                yield* adapters.agentSessions.submitPrompt({
                  ptyProcessId: prepared.ptyProcessId,
                  text: input.renderedPrompt,
                });
                // The write returned. That is all `seed_submitted` claims — the harness handshake
                // below is a separate observation, and its failure must not cost us this receipt.
                yield* advanceStage({
                  operationId: input.record.id,
                  stage: 'seed_submitted',
                  state: 'dispatched',
                  receipt: {
                    value: {
                      agentSessionId: created.agentSessionId,
                      sentAt: watermark,
                      surfaceId: created.surfaceId,
                      paneId: created.paneId,
                    },
                  },
                });
              }),
            );
            // Interruptible again from here: the handshake polls, and holding a mask across it would
            // let an unresponsive harness delay shutdown indefinitely.
            yield* adapters.agentSessions.awaitSeedAcknowledgement({
              agentSessionId: created.agentSessionId,
              ptyProcessId: prepared.ptyProcessId,
            });
            return {
              agentSessionId: created.agentSessionId,
              sentAt: watermark,
              paneId: created.paneId,
            };
          });

        const performHeadless = (input: {
          readonly record: WorkflowOperationRecord;
          readonly harness: WorkflowAgentHarness;
          readonly model?: string | undefined;
          readonly effort?: string | undefined;
          readonly renderedPrompt: string;
          readonly effectiveTimeoutMs: number;
        }) =>
          Effect.gen(function* () {
            yield* assertDispatchable('allocate a headless process');
            yield* adapters.headless.assertCanCreateProcess(input.harness);
            const launchedAt = now();
            return yield* Effect.scoped(
              Effect.gen(function* () {
                // `abandon` is idempotent and a no-op once `start` has begun, so attaching it
                // unconditionally releases an interrupted reservation without touching a real launch.
                const allocation = yield* Effect.acquireRelease(
                  adapters.headless.allocate({
                    harness: input.harness,
                    cwd: identity.destination.worktreePath,
                    prompt: input.renderedPrompt,
                    model: input.model,
                    effort: input.effort,
                  }),
                  (acquired) => acquired.abandon,
                );
                const baseReceipt: HeadlessReceipt = {
                  ptyProcessId: allocation.ptyProcessId,
                  harness: input.harness,
                  effectiveTimeoutMs: input.effectiveTimeoutMs,
                  launchedAt,
                };
                // Written before any process exists, so ownership is durable ahead of the effect.
                yield* advanceStage({
                  operationId: input.record.id,
                  stage: 'allocated',
                  state: 'dispatched',
                  targetKind: 'pty_process',
                  targetId: allocation.ptyProcessId,
                  ptyProcessId: allocation.ptyProcessId,
                  captureOwner: incarnationId,
                  receipt: { value: baseReceipt },
                });
                // Checked here rather than after the next marker: refusing once `starting` is
                // written would leave the one state nothing can classify, and Cancel would block the
                // run instead of stopping it. Refusing now leaves `allocated`, which recovery already
                // reads as "`start` was never called".
                yield* assertDispatchable('start a headless process');
                // The marker that precedes `start`. A crash after this is one write wide and is the
                // only genuinely indeterminate headless state.
                yield* advanceStage({
                  operationId: input.record.id,
                  stage: 'starting',
                  state: 'dispatched',
                });
                const metadata = yield* allocation.start;
                const settledReceipt: HeadlessReceipt = {
                  ...baseReceipt,
                  launchOutcome: metadata.launchOutcome,
                  launchFailureCause: metadata.launchFailureCause,
                };

                if (metadata.launchOutcome === 'spawned') {
                  yield* advanceStage({
                    operationId: input.record.id,
                    stage: 'started',
                    state: 'dispatched',
                    receipt: { value: settledReceipt },
                  });
                  yield* adapters.headless.pin(allocation.ptyProcessId);
                  yield* captures.track({
                    record: input.record,
                    harness: input.harness,
                    ptyProcessId: allocation.ptyProcessId,
                    timeoutMs: input.effectiveTimeoutMs,
                    launchedAt,
                  });
                  return {
                    operationId: input.record.operationKey,
                  } satisfies HeadlessOperationHandle;
                }

                yield* advanceStage({
                  operationId: input.record.id,
                  stage: 'launch_failed',
                  state: 'dispatched',
                  receipt: { value: settledReceipt },
                });
                const current = (yield* die(operations.findById(input.record.id))) ?? input.record;

                if (metadata.launchOutcome === 'preparation_failed') {
                  // Nothing reached a backend, so there is no operational outcome to route on.
                  // Manufacturing a failed `HeadlessOperationResult` would misrepresent the fault and
                  // let broken plumbing consume one of the author's bounded retry rounds.
                  yield* settle({
                    record: current,
                    state: 'abandoned',
                    result: {
                      reason: 'preparation_failed',
                      cause: metadata.launchFailureCause,
                    },
                  });
                  return yield* reject({
                    code: 'workflow_operation_launch_failed',
                    message: `The headless agent could not be prepared: ${metadata.launchFailureCause ?? 'unknown cause'}.`,
                    operationId: current.id,
                    detail: { cause: metadata.launchFailureCause },
                  });
                }

                // `spawn_failed`. The backend wraps the spawn *and* its listener registration in one
                // `Effect.try`, so the process may be live right now. That is a confirmed failure of
                // the managed operation — data the author's declared failure route consumes — and
                // never a licence to dispatch again under this identity.
                const result: HeadlessOperationResult = {
                  operationId: current.operationKey,
                  status: 'failed',
                  error: metadata.launchFailureCause ?? 'spawn_failed',
                  exitCode: null,
                };
                const settled = yield* settle({ record: current, state: 'failed', result });
                if (settled) yield* requestStop(settled, 'spawn_failed_process_may_be_live');
                return { operationId: current.operationKey } satisfies HeadlessOperationHandle;
              }),
            );
          });

        /**
         * Cross the Effect→Promise boundary the way author code expects to receive a failure.
         *
         * `Effect.runPromise` rejects with a `FiberFailure` wrapping the real error, so an author
         * catching `ctx.runHeadlessAgent(...)` would see a wrapper whose `code` is undefined and
         * whose message describes a fiber. The SDK contract promises the rejection *is* the error,
         * carrying a stable `code`, so the expected failure is unwrapped and thrown as itself; a
         * genuine defect is still surfaced rather than swallowed.
         */
        const runVerb = <Value, Failure>(effect: Effect.Effect<Value, Failure>): Promise<Value> =>
          Effect.runPromiseExit(
            // The capability itself runs in a fiber the attempt scope owns; the root fiber here does
            // nothing but hand it over and wait. Running the operation directly on an unowned root
            // is what made shutdown unable to reach it.
            Effect.gen(function* () {
              const fiber = yield* Effect.forkIn(effect, attemptScope);
              return yield* Fiber.join(fiber);
            }),
          ).then((exit) => {
            if (Exit.isSuccess(exit)) return exit.value;
            const failure = Cause.failureOption(exit.cause);
            if (Option.isSome(failure)) throw failure.value;
            // Scope closure interrupts the child, and the author's promise has to *settle* — a
            // pending promise nobody will ever resolve is a worse failure than a rejection. It is
            // reported as the same closure diagnostic an after-the-fact call receives, because it is
            // the same fact: the segment this call belonged to is over.
            if (Cause.isInterruptedOnly(exit.cause)) {
              throw new OperationRejection({
                code: 'operation_context_closed',
                message: `Operation context for attempt ${identity.attemptId} closed while this call was still running.`,
              });
            }
            throw Cause.squash(exit.cause);
          });

        /**
         * Run a durable submission's write and its confirmation without interruption.
         *
         * Entered only *after* the pre-boundary marker has committed, and left before anything
         * open-ended — the harness handshake, turn observation, a timeout wait. Masking is not a
         * claim of atomicity: the process can still die here, and the write or the confirming
         * commit can still fail, in which case the marker is what recovery reads and the prompt is
         * never resent. What masking removes is only the *avoidable* case, where our own shutdown
         * lands in the one-write-wide window and manufactures uncertainty out of an orderly stop.
         *
         * The region is kept minimal rather than assumed short: a real PTY write and a real database
         * commit can stall, so a slow one is reported instead of silently delaying shutdown.
         */
        const submitUninterruptibly = <Value, Failure>(
          label: string,
          effect: Effect.Effect<Value, Failure>,
        ): Effect.Effect<Value, Failure> =>
          Effect.uninterruptible(
            Effect.gen(function* () {
              const startedAt = Date.now();
              const result = yield* effect;
              const elapsed = Date.now() - startedAt;
              if (elapsed > maskedSubmissionWarnMs) {
                yield* Effect.sync(() => {
                  console.warn(
                    '[runtime] Workflow submission held interruption longer than expected',
                    { label, elapsedMs: elapsed, attemptId: identity.attemptId },
                  );
                });
              }
              return result;
            }),
          );

        const context: OperationContext = {
          destination: identity.destination,
          worktreePath: identity.destination.worktreePath,
          invocation: {
            runId: identity.runId,
            invocationId: identity.frameId,
            executionId: identity.executionId,
            attempt: identity.attemptIndex,
            kind: identity.invocationKind,
          },

          spawnAgentSession: (input) =>
            runVerb(
              Effect.gen(function* () {
                const renderedPrompt = yield* renderWorkflowPromptEffect({
                  harness: input.harness,
                  promptInput: input,
                  operation: 'spawn_agent_session',
                });
                const request: NormalizedRequest = {
                  capability: 'spawn_agent_session',
                  harness: input.harness,
                  model: input.model ?? null,
                  effort: input.effort ?? null,
                  renderedPrompt,
                };
                const claimed = yield* claimPosition({
                  capability: 'spawn_agent_session',
                  request,
                  ...(input.modifiers ? { metadata: { modifiers: input.modifiers } } : {}),
                });
                let record = claimed.record;
                if (claimed.kind === 'reuse') {
                  const reused = yield* reuseSubmission(claimed.record);
                  if (reused.kind === 'usable') {
                    const saved = readSpawnSessionReceipt(yield* receipt(reused.record));
                    // Only `seed_submitted` yields a handle the callback may rely on. A recorded
                    // pane and session are not a seeded agent, and returning them with an empty
                    // `sentAt` would hand the author a turn target no turn can ever match.
                    if (saved) {
                      return {
                        agentSessionId: saved.agentSessionId,
                        sentAt: saved.sentAt,
                        paneId: saved.paneId,
                      } satisfies AgentSessionHandle;
                    }
                  }
                  record = reused.record;
                }
                return yield* performSpawn({
                  record,
                  harness: input.harness,
                  model: input.model,
                  effort: input.effort,
                  renderedPrompt,
                });
              }),
            ),

          sendAgentPrompt: (input) =>
            runVerb(
              Effect.gen(function* () {
                // Rendering needs the *session's* harness, so it is read from the owner rather than
                // taken from the call site. It is also part of the request identity, which is why it
                // is resolved before the call position is claimed.
                const harness = yield* adapters.agentSessions.sessionHarness(input.agentSessionId);
                const renderedPrompt = yield* renderWorkflowPromptEffect({
                  harness,
                  promptInput: input,
                  operation: 'send_agent_prompt',
                });
                const request: NormalizedRequest = {
                  capability: 'send_agent_prompt',
                  agentSessionId: input.agentSessionId,
                  renderedPrompt,
                };
                const claimed = yield* claimPosition({
                  capability: 'send_agent_prompt',
                  request,
                  ...(input.modifiers ? { metadata: { modifiers: input.modifiers } } : {}),
                });
                let record = claimed.record;
                if (claimed.kind === 'reuse') {
                  const reused = yield* reuseSubmission(claimed.record);
                  if (reused.kind === 'usable') {
                    const saved = readAgentTurnReceipt(yield* receipt(reused.record));
                    if (saved) return saved satisfies AgentTurnTarget;
                  }
                  record = reused.record;
                }
                return yield* performSend({
                  record,
                  agentSessionId: input.agentSessionId,
                  renderedPrompt,
                });
              }),
            ),

          closePane: (paneId) =>
            runVerb(
              Effect.gen(function* () {
                const request: NormalizedRequest = { capability: 'close_pane', paneId };
                const claimed = yield* claimPosition({ capability: 'close_pane', request });
                if (claimed.kind === 'reuse') return;
                yield* assertDispatchable('close a pane');
                yield* adapters.panes.closePane({
                  surfaceId: identity.destination.surfaceId,
                  paneId,
                });
                yield* settle({
                  record: claimed.record,
                  state: 'completed',
                  result: { paneId },
                });
              }),
            ).then(() => undefined),

          getConversationHistory: (agentSessionId) =>
            // A scoped read: no call position, no receipt. A repaired segment simply reads again and
            // may legitimately observe a different answer.
            runVerb(
              Effect.gen(function* () {
                if (state.closed) {
                  return yield* reject({
                    code: 'operation_context_closed',
                    message: `Operation context for attempt ${identity.attemptId} is closed.`,
                  });
                }
                const recovery = identity.agentTurnRecovery;
                if (recovery?.agentSessionId !== agentSessionId) {
                  return yield* adapters.agentSessions.conversationHistory(agentSessionId);
                }
                return yield* conversationGate.withPermits(1)(
                  Effect.gen(function* () {
                    if (state.closed) {
                      return yield* reject({
                        code: 'operation_context_closed',
                        message: `Operation context for attempt ${identity.attemptId} is closed.`,
                      });
                    }
                    if (recoveredConversation) return recoveredConversation;
                    if (recovery.event.outcome !== 'ended') {
                      return yield* reject({
                        code: 'workflow_operation_failed',
                        message: `The exact agent turn selected by Retry ${recovery.event.outcome}; it has no completed response to read.`,
                        detail: { waitId: recovery.waitId, outcome: recovery.event.outcome },
                      });
                    }
                    const messages = yield* adapters.agentSessions.conversationHistory(
                      agentSessionId,
                      {
                        ...recovery.turn,
                        completedAt: recovery.event.recordedAt,
                      },
                    );
                    const hasAssistantContent = messages.some(
                      (message) =>
                        message.role === 'assistant' &&
                        message.parts.some((part) => part.text.trim().length > 0),
                    );
                    if (!hasAssistantContent) {
                      return yield* reject({
                        code: 'workflow_operation_failed',
                        message: `The exact agent turn selected by Retry has no readable assistant response.`,
                        detail: {
                          waitId: recovery.waitId,
                          harnessSessionId: recovery.turn.harnessSessionId,
                          seq: recovery.turn.seq,
                        },
                      });
                    }
                    recoveredConversation = messages;
                    return messages;
                  }),
                );
              }),
            ) as Promise<readonly WorkflowConversationMessage[]>,

          runHeadlessAgent: (input: WorkflowHeadlessAgentInput) =>
            runVerb(
              Effect.gen(function* () {
                const renderedPrompt = yield* renderWorkflowPromptEffect({
                  harness: input.harness,
                  promptInput: input,
                  operation: 'run_headless_agent',
                });
                const request: NormalizedRequest = {
                  capability: 'run_headless_agent',
                  harness: input.harness,
                  model: input.model ?? null,
                  effort: input.effort ?? null,
                  timeoutMs: input.timeoutMs ?? null,
                  renderedPrompt,
                };
                const claimed = yield* claimPosition({
                  capability: 'run_headless_agent',
                  request,
                  dispatch: { effectiveTimeoutMs: input.timeoutMs ?? defaultHeadlessTimeoutMs },
                  ...(input.modifiers ? { metadata: { modifiers: input.modifiers } } : {}),
                });
                if (claimed.kind === 'reuse') {
                  return {
                    operationId: claimed.record.operationKey,
                  } satisfies HeadlessOperationHandle;
                }
                // A redispatch under the same identity keeps the timeout the operation was created
                // with. Adopting a newly changed default here would silently re-scope an operation
                // the author never touched.
                const recorded = yield* envelopeOf(claimed.record);
                const effectiveTimeoutMs =
                  recorded?.dispatch?.effectiveTimeoutMs ??
                  input.timeoutMs ??
                  defaultHeadlessTimeoutMs;
                return yield* performHeadless({
                  record: claimed.record,
                  harness: input.harness,
                  model: input.model,
                  effort: input.effort,
                  renderedPrompt,
                  effectiveTimeoutMs,
                });
              }),
            ),

          log: (level: WorkflowLogLevel, message: string) =>
            runVerb(appendDiagnostic('log', { source: 'author_log', level, message })).then(
              () => undefined,
            ),

          setUiFeedback: (feedback: WorkflowUiFeedback) =>
            runVerb(
              appendDiagnostic('ui_feedback', {
                source: 'ui_feedback',
                kind: feedback.kind ?? 'info',
                ...(feedback.phase === undefined ? {} : { phase: feedback.phase }),
                ...(feedback.message === undefined ? {} : { message: feedback.message }),
              }),
            ).then(() => undefined),
        };

        const value = yield* use(context);
        const recorded = yield* die(operations.listForExecution(identity.executionId));
        // Closed before the scope is, so a verb reached from a promise the callback never awaited is
        // refused at entry rather than racing the scope's own teardown.
        state.closed = true;
        return {
          value,
          consumedCallCount: state.consumed,
          recordedCallCount: recorded.length,
        };
      }),
    );

  return withAttemptContext;
}
