import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type {
  WorkflowAgentHarness,
  WorkflowHeadlessLaunch,
  WorkflowHeadlessAgentInput,
  WorkflowHeadlessResult,
  WorkflowWaitCondition,
} from '@yourtechbudstudio/isagi-workflow-sdk';
import { Context, Effect, Layer } from 'effect';

import { harnessDefinition } from '../agent-sessions/harness/definitions.js';
import { HarnessAdapterRegistry } from '../agent-sessions/harness/index.js';
import type { HarnessAdapterError } from '../agent-sessions/index.js';
import { HarnessControlPlane, type HarnessLaunchBlocked } from '../harness-control-plane/index.js';
import { PtyService } from '../pty-processes/index.js';
import type { PtyLaunchError } from '../pty-processes/pty.service.js';
import { InternalRuntimeEventBus } from '../runtime-events/index.js';
import { renderWorkflowPromptEffect, type WorkflowPromptInputError } from './prompt-renderer.js';

export const defaultHeadlessTimeoutMs = 10 * 60_000;
const timeoutTerminationGraceMs = 1_000;

export interface WorkflowHeadlessService {
  readonly runHeadlessAgent: (input: {
    readonly runId: number;
    readonly worktreePath: string;
    readonly prompt: WorkflowHeadlessAgentInput;
  }) => Effect.Effect<
    { readonly opId: string; readonly launch: WorkflowHeadlessLaunch },
    PtyLaunchError | HarnessAdapterError | HarnessLaunchBlocked | WorkflowPromptInputError
  >;
  readonly reissue: (input: {
    readonly runId: number;
    readonly worktreePath: string;
    readonly ops: readonly WorkflowHeadlessWaitOp[];
  }) => Effect.Effect<void, PtyLaunchError | HarnessAdapterError | HarnessLaunchBlocked>;
  readonly completedResults: (
    condition: Extract<WorkflowWaitCondition, { readonly kind: 'headless_agent' }>,
  ) => Effect.Effect<readonly WorkflowHeadlessResult[] | null>;
  readonly releaseOps: (input: { readonly opIds: readonly string[] }) => Effect.Effect<void>;
}

export type WorkflowHeadlessWaitOp = Extract<
  WorkflowWaitCondition,
  { readonly kind: 'headless_agent' }
>['ops'][number];

type LiveHeadlessOp = {
  readonly runId: number;
  readonly opId: string;
  readonly launch: WorkflowHeadlessLaunch;
  readonly ptyProcessId: number;
  timeout: ReturnType<typeof setTimeout> | null;
};

type TrackedHeadlessOp =
  | LiveHeadlessOp
  | {
      readonly runId: number;
      readonly opId: string;
      readonly launch: WorkflowHeadlessLaunch;
      readonly result: WorkflowHeadlessResult;
    };

type CapturedHeadlessOutput = {
  readonly raw: string;
  readonly output: string;
};

export const WorkflowHeadless =
  Context.GenericTag<WorkflowHeadlessService>('isagi/WorkflowHeadless');

export const WorkflowHeadlessLive = Layer.scoped(
  WorkflowHeadless,
  Effect.gen(function* () {
    const harnesses = yield* HarnessAdapterRegistry;
    const pty = yield* PtyService;
    const eventBus = yield* InternalRuntimeEventBus;
    const controlPlane = yield* HarnessControlPlane;
    const byOpId = new Map<string, TrackedHeadlessOp>();
    const opIdByPtyProcessId = new Map<number, string>();

    const completeOp = (input: {
      readonly opId: string;
      readonly result: WorkflowHeadlessResult;
    }) =>
      Effect.gen(function* () {
        const tracked = byOpId.get(input.opId);
        if (!tracked || 'result' in tracked) return;
        if (tracked.timeout) clearTimeout(tracked.timeout);
        opIdByPtyProcessId.delete(tracked.ptyProcessId);
        yield* pty.unpin({ ptyProcessId: tracked.ptyProcessId });
        byOpId.set(input.opId, {
          runId: tracked.runId,
          opId: tracked.opId,
          launch: tracked.launch,
          result: input.result,
        });
        yield* eventBus.publish({
          type: 'headless_op_completed',
          runId: tracked.runId,
          opId: tracked.opId,
        });
      });

    const launchOp = (input: {
      readonly runId: number;
      readonly opId: string;
      readonly worktreePath: string;
      readonly launch: WorkflowHeadlessLaunch;
    }) =>
      Effect.gen(function* () {
        yield* controlPlane.assertCanCreateProcess(input.launch.harness);
        const existing = byOpId.get(input.opId);
        if (existing && !('result' in existing)) return;
        const launchInput = yield* harnesses.buildHeadlessLaunch({
          harness: input.launch.harness,
          cwd: input.worktreePath,
          prompt: input.launch.prompt,
          model: input.launch.model,
          effort: input.launch.effort,
        });
        const metadata = yield* pty.launch(launchInput);
        yield* pty.pin({ ptyProcessId: metadata.ptyProcessId });
        const timeout = setTimeout(() => {
          void Effect.runPromise(
            timeoutOp({
              opId: input.opId,
              ptyProcessId: metadata.ptyProcessId,
            }).pipe(
              Effect.catchAll((error) =>
                Effect.sync(() => {
                  console.warn('[runtime] Headless workflow timeout handling failed', error);
                }),
              ),
            ),
          );
        }, input.launch.timeoutMs);
        timeout.unref();
        byOpId.set(input.opId, {
          runId: input.runId,
          opId: input.opId,
          launch: input.launch,
          ptyProcessId: metadata.ptyProcessId,
          timeout,
        });
        opIdByPtyProcessId.set(metadata.ptyProcessId, input.opId);
      });

    const timeoutOp = (input: { readonly opId: string; readonly ptyProcessId: number }) =>
      Effect.gen(function* () {
        const tracked = byOpId.get(input.opId);
        if (!tracked || 'result' in tracked) return;
        const captured = yield* outputForPty(pty, tracked.launch.harness, input.ptyProcessId).pipe(
          Effect.orElseSucceed(() => ({ raw: '', output: '' })),
        );
        yield* completeOp({
          opId: input.opId,
          result: {
            opId: input.opId,
            status: 'failed',
            error: 'timeout',
            exitCode: null,
            output: captured.output,
          },
        });
        yield* pty
          .terminate({
            ptyProcessId: input.ptyProcessId,
            gracefulTimeoutMs: timeoutTerminationGraceMs,
          })
          .pipe(Effect.ignore);
      });

    // Fully drop a single tracked op and free its resources. A live op's PTY is
    // terminated and unpinned; a completed op only needs its retained result
    // entry dropped (its PTY was already torn down on completion).
    const releaseOp = (opId: string) =>
      Effect.gen(function* () {
        const tracked = byOpId.get(opId);
        if (!tracked) return;
        byOpId.delete(opId);
        if ('result' in tracked) return;
        if (tracked.timeout) clearTimeout(tracked.timeout);
        opIdByPtyProcessId.delete(tracked.ptyProcessId);
        yield* pty.unpin({ ptyProcessId: tracked.ptyProcessId });
        yield* pty
          .terminate({
            ptyProcessId: tracked.ptyProcessId,
            gracefulTimeoutMs: timeoutTerminationGraceMs,
          })
          .pipe(Effect.ignore);
      });

    // Cancel every op still tracked for a run. Invoked when a run reaches a
    // terminal state so an orphaned or in-flight headless PTY cannot keep running
    // (and mutating the worktree) after its owning run is already dead.
    const cancelRunOps = (runId: number) =>
      Effect.gen(function* () {
        const opIds = [...byOpId.values()]
          .filter((tracked) => tracked.runId === runId)
          .map((tracked) => tracked.opId);
        for (const opId of opIds) yield* releaseOp(opId);
      });

    const subscription = yield* eventBus.subscribe({
      types: [
        'pty_process_exited',
        'pty_process_failed',
        'pty_process_killed',
        'workflow_run_terminal',
      ],
    });
    yield* Effect.addFinalizer(() => subscription.unsubscribe);
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const event = yield* subscription.take;
          if (event.type === 'workflow_run_terminal') {
            yield* cancelRunOps(event.runId);
            return;
          }
          if (
            event.type !== 'pty_process_exited' &&
            event.type !== 'pty_process_failed' &&
            event.type !== 'pty_process_killed'
          ) {
            return;
          }
          const opId = opIdByPtyProcessId.get(event.ptyProcessId);
          if (!opId) return;
          const tracked = byOpId.get(opId);
          if (!tracked || 'result' in tracked) return;
          const captured = yield* outputForPty(
            pty,
            tracked.launch.harness,
            event.ptyProcessId,
          ).pipe(
            Effect.orElseSucceed(() => ({
              raw: '',
              output: '',
            })),
          );
          const semanticError = semanticErrorForHeadlessOutput(
            tracked.launch.harness,
            captured.raw,
          );
          const exitCode = event.type === 'pty_process_exited' ? event.exitCode : null;
          const status =
            event.type === 'pty_process_exited' && exitCode === 0 && semanticError === null
              ? 'completed'
              : 'failed';
          yield* completeOp({
            opId,
            result: {
              opId,
              status,
              output: captured.output,
              ...(status === 'failed'
                ? {
                    error:
                      semanticError ??
                      (event.type === 'pty_process_killed'
                        ? 'killed'
                        : event.type === 'pty_process_failed'
                          ? 'process_failed'
                          : 'non_zero_exit'),
                    exitCode,
                  }
                : { exitCode }),
            },
          });
        }).pipe(
          Effect.catchAll((error) =>
            Effect.sync(() => {
              console.warn('[runtime] Headless workflow PTY event handling failed', error);
            }),
          ),
        ),
      ),
    );

    const service = {
      runHeadlessAgent: (input) =>
        Effect.gen(function* () {
          const renderedPrompt = yield* renderWorkflowPromptEffect({
            harness: input.prompt.harness,
            promptInput: input.prompt,
            operation: 'run_headless_agent',
          });
          const launch = normalizeHeadlessLaunch(input.prompt, renderedPrompt);
          const opId = `headless:${randomUUID()}`;
          yield* launchOp({
            runId: input.runId,
            opId,
            worktreePath: input.worktreePath,
            launch,
          });
          return { opId, launch };
        }),
      reissue: (input) =>
        Effect.gen(function* () {
          for (const op of input.ops) {
            // Skip any op we still track, whether it is live or already holds a
            // result; only launch ops absent from this runtime's tracker.
            if (byOpId.has(op.opId)) continue;
            yield* launchOp({
              runId: input.runId,
              opId: op.opId,
              worktreePath: input.worktreePath,
              launch: op.launch,
            });
          }
        }),
      completedResults: (condition) =>
        Effect.sync(() => {
          const results: WorkflowHeadlessResult[] = [];
          for (const op of condition.ops) {
            const tracked = byOpId.get(op.opId);
            if (!tracked || !('result' in tracked)) return null;
            results.push(tracked.result);
          }
          return results;
        }),
      // Drop tracker entries for ops whose results the reducer has consumed. The
      // persisted resume payload carries the results forward, so retaining the
      // captured output here would only grow the map unboundedly across a long
      // run's repeated headless judgments.
      releaseOps: (input) =>
        Effect.gen(function* () {
          for (const opId of input.opIds) yield* releaseOp(opId);
        }),
    } satisfies WorkflowHeadlessService;

    return yield* Effect.acquireRelease(Effect.succeed(service), () =>
      Effect.sync(() => {
        for (const tracked of byOpId.values()) {
          if ('result' in tracked) continue;
          if (tracked.timeout) clearTimeout(tracked.timeout);
        }
        byOpId.clear();
        opIdByPtyProcessId.clear();
      }),
    );
  }),
);

export function normalizeHeadlessLaunch(
  input: WorkflowHeadlessAgentInput,
  renderedPrompt: string,
): WorkflowHeadlessLaunch {
  return {
    prompt: renderedPrompt,
    harness: input.harness,
    model: input.model,
    effort: input.effort,
    timeoutMs: input.timeoutMs ?? defaultHeadlessTimeoutMs,
  };
}

function outputForPty(
  pty: import('../pty-processes/index.js').PtyServiceShape,
  harness: WorkflowAgentHarness,
  ptyProcessId: number,
): Effect.Effect<CapturedHeadlessOutput, unknown> {
  return Effect.gen(function* () {
    const plan = yield* pty.getAttachmentPlan({ ptyProcessId });
    const raw = plan.session.logPath ? readFileSync(plan.session.logPath, 'utf8') : '';
    return {
      raw,
      output: extractHeadlessOutput(harness, raw),
    };
  });
}

export function extractHeadlessOutput(harness: WorkflowAgentHarness, raw: string): string {
  return harnessDefinition(harness).launch.extractHeadlessOutput(raw);
}

export function semanticErrorForHeadlessOutput(
  harness: WorkflowAgentHarness,
  raw: string,
): string | null {
  return harnessDefinition(harness).launch.semanticHeadlessError?.(raw) ?? null;
}
