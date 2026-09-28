import { readFileSync } from 'node:fs';

import { Effect } from 'effect';

import { harnessDefinition } from '../../agent-sessions/harness/definitions.js';
import type { HarnessAdapterRegistryService } from '../../agent-sessions/harness/index.js';
import type { HarnessControlPlaneService } from '../../harness-control-plane/index.js';
import type { PtyServiceShape } from '../../pty-processes/index.js';
import type { EngineRuntime, HeadlessExit, HeadlessPort } from '../engine/runtime.js';
import { errorMessage } from '../state/pure.js';
import { getOperation, settleOperation } from '../store/operations.js';
import { toJson, toNullableJson } from '../store/rows.js';
import type { WorkflowAgentHarness } from '../types.js';
import type { HeadlessOperationRecord } from '../waits/check.js';

/**
 * Headless agent runs: a one-shot harness process whose output is the answer.
 *
 * The process is tracked in memory by its PTY process id. Its exit (or its timeout) stores the
 * output as the operation's `response_text` and wakes the run, whose headless wait then sees every
 * listed operation settled. A restart loses the tracking; startup marks those operations
 * `interrupted` instead.
 */

export const defaultHeadlessTimeoutMs = 10 * 60_000;
const terminationGraceMs = 1_000;

export function startHeadless(
  rt: EngineRuntime,
  input: {
    readonly runId: number;
    readonly operationId: number;
    readonly cwd: string;
    readonly harness: WorkflowAgentHarness;
    readonly prompt: string;
    readonly model?: string | undefined;
    readonly effort?: string | undefined;
    readonly timeoutMs?: number | undefined;
  },
) {
  return Effect.gen(function* () {
    const { ptyProcessId } = yield* rt.deps.headless.start({
      harness: input.harness,
      cwd: input.cwd,
      prompt: input.prompt,
      model: input.model,
      effort: input.effort,
    });
    const timer = setTimeout(() => {
      rt.fork(timeOutHeadless(rt, ptyProcessId), 'workflow headless timeout');
    }, input.timeoutMs ?? defaultHeadlessTimeoutMs);
    timer.unref();
    rt.headlessProcesses.set(ptyProcessId, {
      runId: input.runId,
      operationId: input.operationId,
      harness: input.harness,
      timer,
      timedOut: false,
      settling: false,
    });
    // Cancel may have ended the operation while the launch was in flight: stop what just started.
    const cancelled = yield* rt.read(
      'workflow_read_operation',
      (db) => getOperation(db, input.operationId)?.status !== 'running',
    );
    if (cancelled) {
      yield* stopTracked(rt, ptyProcessId);
      return;
    }
    // A process that failed while launching has already published its exit, before it was
    // tracked; its row says so.
    const exit = yield* rt.deps.headless
      .exitOf(ptyProcessId)
      .pipe(Effect.orElseSucceed(() => null));
    if (exit) yield* settleHeadless(rt, ptyProcessId, exit);
  });
}

/**
 * A job past its timeout is stopped, but it stays tracked until its process has really ended: its
 * exit then settles the operation as a timeout. A stop that fails is recorded as `stop_failed` and
 * the job stays owned, so its eventual exit, or a Cancel, still cleans it up.
 */
function timeOutHeadless(rt: EngineRuntime, ptyProcessId: number): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const tracked = rt.headlessProcesses.get(ptyProcessId);
    if (!tracked) return;
    tracked.timedOut = true;
    const stopped = yield* rt.deps.headless.terminate(ptyProcessId).pipe(Effect.either);
    if (stopped._tag === 'Left') {
      yield* rt.commit('workflow_headless_stop_failed', (_db, emit) =>
        emit({
          runId: tracked.runId,
          category: 'run',
          kind: 'stop_failed',
          message: `Headless process ${ptyProcessId} timed out and could not be stopped: ${errorMessage(stopped.left)}`,
          data: { operationId: tracked.operationId, ptyProcessId, reason: 'timeout' },
        }),
      );
      return;
    }
    const exit = yield* rt.deps.headless
      .exitOf(ptyProcessId)
      .pipe(Effect.orElseSucceed(() => null));
    if (exit) yield* settleHeadless(rt, ptyProcessId, exit);
  });
}

/**
 * Records a tracked process's end on its operation and wakes its run.
 *
 * The process stays tracked until that write commits. If the write fails, the job is still owned
 * and `settleExitedHeadless` settles it on the next check of the run's headless wait.
 *
 * Only a clean exit whose output could be read completes the operation. Output that cannot be read
 * fails it with the reason, rather than handing the graph an empty answer.
 */
export function settleHeadless(
  rt: EngineRuntime,
  ptyProcessId: number,
  exit: HeadlessExit,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const tracked = rt.headlessProcesses.get(ptyProcessId);
    if (!tracked || tracked.settling) return;
    tracked.settling = true;

    const captured = yield* rt.deps.headless
      .capture({ ptyProcessId, harness: tracked.harness })
      .pipe(Effect.either);

    const output = captured._tag === 'Right' ? captured.right : null;
    const error = tracked.timedOut
      ? 'timeout'
      : output === null
        ? `output_unavailable: ${errorMessage(captured._tag === 'Left' ? captured.left : null)}`
        : (output.semanticError ??
          (exit.status === 'killed'
            ? 'killed'
            : exit.status === 'failed'
              ? 'process_failed'
              : exit.exitCode === 0
                ? null
                : 'non_zero_exit'));
    const record: HeadlessOperationRecord =
      error === null ? { exitCode: exit.exitCode } : { exitCode: exit.exitCode, error };
    const settled = yield* rt
      .commit('workflow_headless_settled', (db, emit) => {
        // Cancel may already have ended the operation.
        if (getOperation(db, tracked.operationId)?.status !== 'running') return;
        settleOperation(db, emit, tracked.operationId, error === null ? 'completed' : 'failed', {
          responseText: output?.output ?? null,
          resultJson: toJson(record),
          harnessSessionId: output?.harnessSessionId ?? null,
          usageJson: toNullableJson(output?.usage),
        });
      })
      .pipe(Effect.either);
    if (settled._tag === 'Left') {
      // Still owned: the next check of the run's headless wait settles it again.
      tracked.settling = false;
      return yield* Effect.fail(settled.left);
    }
    // Ownership ends only once the operation's end is committed.
    rt.headlessProcesses.delete(ptyProcessId);
    if (tracked.timer) clearTimeout(tracked.timer);
    yield* rt.deps.headless.release(ptyProcessId);
    rt.kick(tracked.runId);
  });
}

/**
 * Settles any tracked job among these operations whose process has already exited: recovery for a
 * settlement write that failed, run from every check of a headless wait.
 */
export function settleExitedHeadless(
  rt: EngineRuntime,
  operationIds: readonly number[],
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    for (const [ptyProcessId, tracked] of rt.headlessProcesses) {
      if (!operationIds.includes(tracked.operationId) || tracked.settling) continue;
      const exit = yield* rt.deps.headless
        .exitOf(ptyProcessId)
        .pipe(Effect.orElseSucceed(() => null));
      if (exit) yield* settleHeadless(rt, ptyProcessId, exit);
    }
  });
}

/**
 * Cancel's half, after Cancel has already ended the run's headless operations as `interrupted` in its
 * own transaction: stop their processes, best effort. A process that will not stop is reported as a
 * `stop_failed` event and stays tracked, so its eventual exit still releases it.
 */
export function stopRunHeadless(rt: EngineRuntime, runId: number): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const tracked = [...rt.headlessProcesses.entries()].filter(
      ([, entry]) => entry.runId === runId,
    );
    for (const [ptyProcessId] of tracked) yield* stopTracked(rt, ptyProcessId);
  });
}

/**
 * Stops one tracked process whose operation has already ended. A stopped process is released; one
 * that will not stop is reported as `stop_failed` and stays tracked, so its exit still releases it.
 */
function stopTracked(rt: EngineRuntime, ptyProcessId: number): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const entry = rt.headlessProcesses.get(ptyProcessId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    const stopped = yield* rt.deps.headless.terminate(ptyProcessId).pipe(Effect.either);
    if (stopped._tag === 'Right') {
      rt.headlessProcesses.delete(ptyProcessId);
      yield* rt.deps.headless.release(ptyProcessId);
      return;
    }
    yield* rt.commit('workflow_headless_stop_failed', (_db, emit) =>
      emit({
        runId: entry.runId,
        category: 'run',
        kind: 'stop_failed',
        message: `Headless process ${ptyProcessId} could not be stopped: ${errorMessage(stopped.left)}`,
        data: { operationId: entry.operationId, ptyProcessId },
      }),
    );
  });
}

/** The live port: harness launch envelopes, PTY processes and their logs. */
export function makeHeadlessPort(deps: {
  readonly harnesses: HarnessAdapterRegistryService;
  readonly controlPlane: HarnessControlPlaneService;
  readonly pty: PtyServiceShape;
}): HeadlessPort {
  return {
    start: (input) =>
      Effect.gen(function* () {
        yield* deps.controlPlane.assertCanCreateProcess(input.harness);
        const launch = yield* deps.harnesses.buildHeadlessLaunch(input);
        const metadata = yield* deps.pty.launch(launch);
        yield* deps.pty.pin({ ptyProcessId: metadata.ptyProcessId });
        return { ptyProcessId: metadata.ptyProcessId };
      }),
    exitOf: (ptyProcessId) =>
      Effect.map(deps.pty.getAttachmentPlan({ ptyProcessId }), ({ session }) =>
        session.status === 'exited' || session.status === 'failed' || session.status === 'killed'
          ? { status: session.status, exitCode: session.exitCode ?? null }
          : null,
      ),
    capture: (input) =>
      Effect.gen(function* () {
        const plan = yield* deps.pty.getAttachmentPlan({ ptyProcessId: input.ptyProcessId });
        const logPath = plan.session.logPath;
        if (!logPath) {
          return yield* Effect.fail(
            new Error(`Headless process ${input.ptyProcessId} kept no output log.`),
          );
        }
        const raw = yield* Effect.try(() => readFileSync(logPath, 'utf8'));
        const launch = harnessDefinition(input.harness).launch;
        const provenance = launch.extractHeadlessProvenance?.(raw);
        return {
          output: launch.extractHeadlessOutput(raw),
          semanticError: launch.semanticHeadlessError?.(raw) ?? null,
          harnessSessionId: provenance?.harnessSessionId ?? null,
          usage: provenance?.usage ?? null,
        };
      }),
    terminate: (ptyProcessId) =>
      deps.pty
        .terminate({ ptyProcessId, gracefulTimeoutMs: terminationGraceMs })
        .pipe(Effect.asVoid),
    release: (ptyProcessId) => deps.pty.unpin({ ptyProcessId }),
  };
}
