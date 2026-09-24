import assert from 'node:assert/strict';
import test from 'node:test';

import type { OperationContext } from '@yourtechbudstudio/isagi-workflow-sdk';
import { Effect, Fiber } from 'effect';

import { OperationRejection } from './errors.js';
import { makeOperationHarness, run, runCallback, type OperationHarness } from './test-support.js';

/**
 * Lifetime: what owns a verb's work, and what ends it.
 *
 * The distinction these tests exist for is that an attempt and an operation do not have the same
 * lifetime. Callback setup belongs to the invoking attempt and must not outlive it; a submitted
 * headless capture belongs to the runtime incarnation and must survive the callback that started it.
 * A single scope for both would get one of the two wrong in a way no state assertion would catch.
 */

const prompt = { harness: 'claude' as const, prompt: 'judge this' };

/** Fails rather than hanging the suite if a promise never settles. */
async function settles<A>(promise: Promise<A>, within = 2_000): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`promise did not settle within ${within}ms`)),
      within,
    );
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function expectClosure(promise: Promise<unknown>): Promise<OperationRejection> {
  try {
    await settles(promise);
  } catch (cause) {
    if (cause instanceof OperationRejection) return cause;
    throw cause;
  }
  throw new Error('expected the in-flight verb to be interrupted');
}

test('a verb still running when the callback returns is interrupted, and its promise settles', async () => {
  const harness = await makeOperationHarness();
  const built = await harness.service();
  try {
    // Author code that starts work and forgets to await it. The segment commits, the attempt is
    // over, and nothing should still be polling a PTY on its behalf.
    harness.state.hangs.add('prepareSend');
    let abandoned: Promise<unknown> | null = null;
    await runCallback(
      built.service.withAttemptContext(harness.identity, (ctx: OperationContext) =>
        Effect.sync(() => {
          abandoned = ctx.sendAgentPrompt({ agentSessionId: 42, prompt: 'go' });
          abandoned.catch(() => undefined);
        }),
      ),
    );

    const rejection = await expectClosure(abandoned!);
    assert.equal(rejection.code, 'operation_context_closed');
    // Interrupted before it reached a boundary, so nothing was recorded and nothing was sent.
    assert.equal(harness.state.counters.promptWrites, 0);
    const recorded = await run(
      harness.fixture.operations.listForExecution(harness.identity.executionId),
    );
    assert.equal(recorded.length, 0);
  } finally {
    await built.close();
    harness.close();
  }
});

test('interrupting the fiber running a callback interrupts the verbs it is waiting on', async () => {
  const harness = await makeOperationHarness();
  const built = await harness.service();
  try {
    harness.state.hangs.add('prepareSeed');
    let inFlight: Promise<unknown> | null = null;
    const fiber = Effect.runFork(
      built.service.withAttemptContext(harness.identity, (ctx: OperationContext) =>
        Effect.tryPromise({
          try: () => {
            inFlight = ctx.spawnAgentSession({ harness: 'claude', prompt: 'start here' });
            inFlight.catch(() => undefined);
            return inFlight;
          },
          catch: (cause) => cause,
        }),
      ),
    );
    // Wait until the verb has genuinely reached the hanging owner call, so the interruption below
    // lands on running work rather than on a fiber that has not started.
    await waitFor(() => harness.state.counters.spawnCreate === 1);

    // Shutdown: whoever is running the callback is interrupted, which closes the attempt scope.
    await Effect.runPromise(Fiber.interrupt(fiber));

    const rejection = await expectClosure(inFlight!);
    assert.equal(rejection.code, 'operation_context_closed');
    // The resource half was created and recorded; the seed never was, and never will be resent.
    assert.equal(harness.state.counters.promptWrites, 0);
    const recorded = await run(
      harness.fixture.operations.listForExecution(harness.identity.executionId),
    );
    assert.equal(recorded[0]?.stage, 'session_created');
  } finally {
    await built.close();
    harness.close();
  }
});

test('an interrupted dispatch releases the owner reservation it was holding', async () => {
  const harness = await makeOperationHarness();
  const built = await harness.service();
  try {
    harness.state.launchOutcomes = [{ kind: 'hang' }];
    let inFlight: Promise<unknown> | null = null;
    const fiber = Effect.runFork(
      built.service.withAttemptContext(harness.identity, (ctx: OperationContext) =>
        Effect.tryPromise({
          try: () => {
            inFlight = ctx.runHeadlessAgent(prompt);
            inFlight.catch(() => undefined);
            return inFlight;
          },
          catch: (cause) => cause,
        }),
      ),
    );
    await waitFor(() => harness.state.counters.starts === 1);
    await Effect.runPromise(Fiber.interrupt(fiber));
    await expectClosure(inFlight!);

    // The allocation was acquired with a release that abandons it, so an interrupted start hands the
    // reservation back rather than leaving a row nobody owns.
    assert.equal(harness.state.abandoned.length, 1);
    const recorded = (
      await run(harness.fixture.operations.listForExecution(harness.identity.executionId))
    )[0]!;
    assert.equal(recorded.ptyProcessId, harness.state.abandoned[0]);
    // And the stage is the honest one: the marker before `start` committed, its outcome never did.
    assert.equal(recorded.stage, 'starting');
  } finally {
    await built.close();
    harness.close();
  }
});

test('an interrupt aimed at the write window is held until the confirmation commits', async () => {
  const harness = await makeOperationHarness();
  const built = await harness.service();
  try {
    // The one window where interruption would be actively harmful: after the marker names a
    // submission and before anything confirms it. An interrupt landing here would settle the
    // operation `uncertain` and block the run, turning an orderly shutdown into a stuck workflow.
    harness.state.submitDelayMs = 150;
    let inFlight: Promise<unknown> | null = null;
    const fiber = Effect.runFork(
      built.service.withAttemptContext(harness.identity, (ctx: OperationContext) =>
        Effect.tryPromise({
          try: () => {
            inFlight = ctx.sendAgentPrompt({ agentSessionId: 42, prompt: 'go' });
            inFlight.catch(() => undefined);
            return inFlight;
          },
          catch: (cause) => cause,
        }),
      ),
    );
    await waitFor(async () => {
      const recorded = await run(
        harness.fixture.operations.listForExecution(harness.identity.executionId),
      );
      return recorded[0]?.stage === 'submitting';
    });

    await Effect.runPromise(Fiber.interrupt(fiber));
    await settles(inFlight!).catch(() => undefined);

    const recorded = (
      await run(harness.fixture.operations.listForExecution(harness.identity.executionId))
    )[0]!;
    // The write happened and was confirmed, despite the interrupt arriving mid-window.
    assert.equal(harness.state.counters.promptWrites, 1);
    assert.equal(recorded.stage, 'submitted');
    assert.notEqual(recorded.state, 'uncertain');

    // Masking is not atomicity, and the record does not pretend otherwise: recovery still reads the
    // marker, and a process killed here would still leave `submitting` for evidence to settle.
    assert.ok(recorded.submissionWatermark);
  } finally {
    await built.close();
    harness.close();
  }
});

test('submitted capture is the service’s, survives the attempt, and ends with the incarnation', async () => {
  const harness = await makeOperationHarness();
  const built = await harness.service();
  let key = '';
  try {
    key = (
      await runCallback(
        built.service.withAttemptContext(harness.identity, (ctx: OperationContext) =>
          Effect.tryPromise({ try: () => ctx.runHeadlessAgent(prompt), catch: (c) => c }),
        ),
      )
    ).value.operationId;

    // The attempt scope has closed. The operation crossed its durable ownership boundary before
    // that, so the capture is now the incarnation's and is still running.
    const record = (await run(harness.fixture.operations.findByKey(key)))!;
    assert.equal(record.state, 'dispatched');
    assert.equal(record.stage, 'started');
    assert.equal(record.captureOwner, built.service.incarnationId);

    // A verb from the closed attempt is refused, while that capture continues — the two lifetimes
    // are genuinely different, not the same scope viewed twice.
    const rejection = await expectClosure(
      (async () => {
        throw await capturedRejection(harness, built.service);
      })(),
    );
    assert.equal(rejection.code, 'operation_context_closed');
  } finally {
    // Layer shutdown is the capture's own end, through the incarnation's finalizers.
    await built.close();
    const afterShutdown = (await run(harness.fixture.operations.findByKey(key)))!;
    // Shutdown stops observing; it does not invent an outcome for work whose result nobody saw.
    assert.equal(afterShutdown.state, 'dispatched');
    assert.equal(afterShutdown.settledAt, null);
    harness.close();
  }
});

test('layer shutdown releases the timers service-owned capture was holding', async () => {
  const harness = await makeOperationHarness();
  const built = await harness.service();
  let key = '';
  try {
    key = (
      await runCallback(
        built.service.withAttemptContext(harness.identity, (ctx: OperationContext) =>
          Effect.tryPromise({
            try: () => ctx.runHeadlessAgent({ ...prompt, timeoutMs: 120 }),
            catch: (c) => c,
          }),
        ),
      )
    ).value.operationId;
  } finally {
    // Closed well before the timeout would have fired. The incarnation's own finalizer owns these
    // timers, so shutting it down must stop them rather than leave a callback that will later write
    // a `timeout` failure against a database the test has already torn down.
    await built.close();
  }
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const record = (await run(harness.fixture.operations.findByKey(key)))!;
    assert.equal(record.state, 'dispatched');
    assert.equal(record.settledAt, null, 'a released timer did not fire after shutdown');
    assert.equal(harness.state.counters.terminations, 0);
  } finally {
    harness.close();
  }
});

test('shutdown racing a fired timeout leaves no fiber writing after the runtime is gone', async () => {
  const harness = await makeOperationHarness();
  const built = await harness.service();
  let key = '';
  try {
    // A timeout short enough that shutdown and the firing genuinely race. Either side may win; what
    // must never happen is a settlement landing *after* the incarnation ended, against a runtime
    // that has already released everything it owned.
    key = (
      await runCallback(
        built.service.withAttemptContext(harness.identity, (ctx: OperationContext) =>
          Effect.tryPromise({
            try: () => ctx.runHeadlessAgent({ ...prompt, timeoutMs: 1 }),
            catch: (c) => c,
          }),
        ),
      )
    ).value.operationId;
  } finally {
    await built.close();
  }
  try {
    // Whatever the race decided, it decided it before shutdown completed. Snapshot and prove nothing
    // moves afterwards — the assertion holds for either winner, so it is about the leak rather than
    // about who won.
    const atShutdown = (await run(harness.fixture.operations.findByKey(key)))!;
    const terminationsAtShutdown = harness.state.counters.terminations;

    await new Promise((resolve) => setTimeout(resolve, 300));

    const later = (await run(harness.fixture.operations.findByKey(key)))!;
    assert.equal(later.state, atShutdown.state);
    assert.equal(later.settledAt, atShutdown.settledAt);
    assert.equal(later.stopState, atShutdown.stopState);
    assert.deepEqual(later.result, atShutdown.result);
    assert.equal(harness.state.counters.terminations, terminationsAtShutdown);
  } finally {
    harness.close();
  }
});

/** Reaches a closed context the way a stray author promise would. */
async function capturedRejection(
  harness: OperationHarness,
  service: Awaited<ReturnType<OperationHarness['service']>>['service'],
): Promise<unknown> {
  let escaped: OperationContext | null = null;
  await runCallback(
    service.withAttemptContext(harness.identity, (ctx: OperationContext) =>
      Effect.sync(() => {
        escaped = ctx;
      }),
    ),
  );
  return escaped!.log('info', 'too late').then(
    () => new Error('expected the closed context to refuse'),
    (cause: unknown) => cause,
  );
}

async function waitFor(predicate: () => boolean | Promise<boolean>, within = 2_000) {
  const deadline = Date.now() + within;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('condition was never reached');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
