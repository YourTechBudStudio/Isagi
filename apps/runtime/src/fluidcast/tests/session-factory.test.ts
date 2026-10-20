import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import type { SubscriptionMessage } from '@yourtechbudstudio/fluidcast-harness/protocol';
import type { TranscriptEntry } from '@yourtechbudstudio/fluidcast-tool-agent';
import { Effect, Exit, Layer, Option, Stream } from 'effect';

import { continueCallLabel, continueMessage } from '../continuation.js';
import { FluidcastSessionUnreadable, FluidcastStartFailed } from '../errors.js';
import type { FluidcastSessionId } from '../ids.js';
import { buildFluidcastModels } from '../models.js';
import {
  buildFluidcastSession,
  type BuiltFluidcastSession,
  type FluidcastSessionInput,
} from '../session-factory.js';
import {
  fakeWorkerType,
  fluidcastConfig,
  recordingHttpClient,
  recordingWorkers,
  stubRegistry,
  withLaunchEnvironment,
  type FakeWorkerOptions,
} from './support.js';

const answeredHistory: TranscriptEntry[] = [
  { _tag: 'prompt', source: 'earlier', text: 'Explain the plan.', parentToolUseId: null },
  { _tag: 'text', text: 'The plan has three steps.', parentToolUseId: null },
];

const baseInput: FluidcastSessionInput = {
  agentSessionId: 7,
  fluidcastSessionId: 'fluidcast-1' as FluidcastSessionId,
  harness: 'claude',
  cwd: '/repo',
  harnessSessionId: 'native-1',
};

interface Scenario {
  readonly input?: Partial<FluidcastSessionInput>;
  readonly worker?: FakeWorkerOptions;
  readonly structuredOutput?: boolean;
  readonly withClaude?: boolean;
  readonly instrumentationFails?: boolean;
}

/**
 * Builds a session with fake workers and a real model over a recording HTTP client, then runs
 * `body` on it inside the session's scope.
 */
function scenario<A>(
  options: Scenario,
  body: (
    built: BuiltFluidcastSession,
    http: ReturnType<typeof recordingHttpClient>,
  ) => Effect.Effect<A>,
) {
  const http = recordingHttpClient();
  const fake = fakeWorkerType(options.worker);
  const recording = recordingWorkers(fake.worker);
  const config = fluidcastConfig({ structuredOutput: options.structuredOutput ?? false });
  return withLaunchEnvironment(options.withClaude ?? true, async (launchEnvironment, bin) => {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const models = yield* buildFluidcastModels(config);
          const built = yield* buildFluidcastSession(
            { ...baseInput, ...options.input },
            { config, models, workers: recording.workers },
          );
          return yield* body(built, http);
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            http.layer,
            launchEnvironment,
            stubRegistry({ fails: options.instrumentationFails ?? false }),
          ),
        ),
      ),
    );
    return { exit, calls: fake.calls, given: recording.given, http, bin };
  });
}

const firstSnapshot = (built: BuiltFluidcastSession) =>
  Effect.map(Stream.runHead(built.session.subscribe()), (message) => {
    const first = Option.getOrThrow(message) as SubscriptionMessage;
    assert.equal(first._tag, 'Snapshot');
    return (first as Extract<SubscriptionMessage, { _tag: 'Snapshot' }>).state;
  });

/** Waits until the model was asked to generate, or fails after `ms`. */
const awaitGeneration = (http: ReturnType<typeof recordingHttpClient>, ms = 2_000) =>
  Effect.gen(function* () {
    for (let waited = 0; http.bodies.length === 0; waited += 10) {
      if (waited >= ms) return yield* Effect.die(new Error('no generation request arrived'));
      yield* Effect.sleep('10 millis');
    }
    return http.bodies[0]!;
  });

test('a native session with an answer opens on a continuation start that waits for a tap', async () => {
  const result = await scenario({ worker: { history: answeredHistory } }, (built, http) =>
    Effect.gen(function* () {
      const state = yield* firstSnapshot(built);
      assert.ok(state.start !== null, 'a preloaded start is waiting');
      assert.match(JSON.stringify(state.start), new RegExp(continueMessage));
      assert.match(JSON.stringify(state.start), /The plan has three steps\./);
      assert.equal(state.start.call?.label, continueCallLabel);
      assert.equal(state.start.call?.call.tool, 'forward_agent');
      yield* Effect.sleep('50 millis');
      assert.equal(http.bodies.length, 0, 'nothing generates before Start');

      yield* Effect.orDie(built.session.command({ _tag: 'Start' }));
      const request = yield* awaitGeneration(http);
      const body = JSON.stringify(request);
      assert.ok(
        body.includes(
          '<tool_result call=\\"call_1\\" tool=\\"forward_agent\\">The plan has three steps.',
        ),
        "the last answer reaches the voice's prompt as the answered call's result",
      );
      assert.ok(
        body.includes('Present only the first segment of this result now'),
        "the preset's reply reminder reaches the voice's prompt",
      );
    }),
  );
  assert.ok(Exit.isSuccess(result.exit), String(Exit.isFailure(result.exit) && result.exit.cause));
  assert.deepEqual(result.calls.attach, ['native-1']);
});

test('a native session without an answer opens on the composer', async () => {
  const result = await scenario({ worker: { history: [answeredHistory[0]!] } }, (built) =>
    Effect.map(firstSnapshot(built), (state) => state.start),
  );
  assert.ok(Exit.isSuccess(result.exit));
  assert.equal(result.exit.value, null);
  assert.deepEqual(result.calls.attach, ['native-1']);
});

test('without a native ID nothing is attached and no start waits', async () => {
  const result = await scenario({ input: { harnessSessionId: null } }, (built) =>
    Effect.map(firstSnapshot(built), (state) => state.start),
  );
  assert.ok(Exit.isSuccess(result.exit));
  assert.equal(result.exit.value, null);
  assert.deepEqual(result.calls.attach, []);
  assert.equal(result.calls.connect, 0, 'the worker connects only on the first forward');
});

test('Claude runs the resolved executable, instrumented, in auto mode, with no model or effort', async () => {
  const result = await scenario({ input: { harnessSessionId: null } }, () => Effect.void);
  assert.ok(Exit.isSuccess(result.exit));
  const [options] = result.given.claude;
  assert.ok(options);
  assert.equal(options.executable, join(result.bin, 'claude'));
  assert.equal(options.cwd, '/repo');
  assert.equal(options.permissionMode, 'auto');
  assert.equal(options.settings, '/data/claude/settings.json');
  assert.equal(options.model, undefined);
  assert.equal(options.effort, undefined);
  // The launch base, with the harness's per-invocation overlay on top.
  assert.equal(options.environment?.HOME, '/home/dev');
  assert.equal(options.environment?.ISAGI_AGENT_SESSION_ID, '7');
  assert.equal(options.environment?.ISAGI_SDK_EXECUTION_ID, 'fluidcast-1');
});

test('Codex keeps the bare executable and takes the instrumentation args and thread options', async () => {
  const result = await scenario(
    { input: { harness: 'codex', harnessSessionId: null }, withClaude: false },
    () => Effect.void,
  );
  assert.ok(Exit.isSuccess(result.exit));
  const [options] = result.given.codex;
  assert.ok(options);
  assert.equal(options.executable, undefined);
  assert.deepEqual(options.args, {
    beforeSubcommand: ['--enable', 'hooks'],
    appServer: ['-c', 'x=1'],
  });
  assert.deepEqual(options.thread, {
    config: { bypass_hook_trust: true },
    sessionStartSource: 'startup',
  });
  assert.equal(options.model, undefined);
  assert.equal(options.effort, undefined);
  assert.equal(options.environment?.ISAGI_SDK_EXECUTION_ID, 'fluidcast-1');
});

test('an unreadable native session fails with its reason and builds nothing', async () => {
  for (const reason of ['SessionNotFound', 'SessionUnreadable'] as const) {
    const result = await scenario({ worker: { attachFails: reason } }, () =>
      Effect.die('the session must not build'),
    );
    assert.ok(Exit.isFailure(result.exit));
    const error = Exit.findErrorOption(result.exit);
    assert.ok(Option.isSome(error) && error.value instanceof FluidcastSessionUnreadable);
    assert.equal(error.value.reason, reason);
    assert.equal(result.calls.connect, 0);
  }
});

test('a missing Claude executable and an instrumentation failure fail the start', async () => {
  const missing = await scenario({ withClaude: false }, () => Effect.void);
  const missingError = Exit.isFailure(missing.exit) && Exit.findErrorOption(missing.exit);
  assert.ok(missingError && Option.isSome(missingError));
  assert.ok(missingError.value instanceof FluidcastStartFailed);
  assert.equal(missingError.value.reason, 'executable_not_found');
  assert.equal(missing.given.claude.length, 0);

  const uninstrumented = await scenario({ instrumentationFails: true }, () => Effect.void);
  const error = Exit.isFailure(uninstrumented.exit) && Exit.findErrorOption(uninstrumented.exit);
  assert.ok(error && Option.isSome(error));
  assert.ok(error.value instanceof FluidcastStartFailed);
  assert.equal(error.value.reason, 'instrumentation_failed');
});

test("with structured output only the voice's requests carry the session's JSON Schema", async () => {
  const structured = await scenario(
    { worker: { history: answeredHistory }, structuredOutput: true },
    (built, http) =>
      Effect.gen(function* () {
        yield* Effect.orDie(built.session.command({ _tag: 'Start' }));
        return yield* awaitGeneration(http);
      }),
  );
  assert.ok(Exit.isSuccess(structured.exit));
  const format = structured.exit.value.response_format as {
    type: string;
    json_schema: { name: string; strict: boolean; schema: unknown };
  };
  assert.equal(format.type, 'json_schema');
  assert.equal(format.json_schema.name, 'actions');
  assert.equal(format.json_schema.strict, true);
  const schema = JSON.stringify(format.json_schema.schema);
  // Built from the session's own speakers and tools.
  for (const name of ['host', 'show', 'ask', 'forward_agent']) {
    assert.ok(schema.includes(`"${name}"`), `the schema names ${name}`);
  }

  const plain = await scenario({ worker: { history: answeredHistory } }, (built, http) =>
    Effect.gen(function* () {
      yield* Effect.orDie(built.session.command({ _tag: 'Start' }));
      return yield* awaitGeneration(http);
    }),
  );
  assert.ok(Exit.isSuccess(plain.exit));
  assert.equal(plain.exit.value.response_format, undefined);
});

test('the shared model, which progress uses, stays unconstrained with structured output on', async () => {
  const http = recordingHttpClient();
  const config = fluidcastConfig({ structuredOutput: true });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const models = yield* buildFluidcastModels(config);
        assert.equal(models.structuredOutput, true);
        yield* models.languageModel
          .streamText({ prompt: 'progress' })
          .pipe(Stream.runDrain, Effect.ignore);
      }),
    ).pipe(Effect.provide(http.layer)),
  );
  assert.equal(http.bodies.length, 1);
  assert.equal(http.bodies[0]!.response_format, undefined);
});
