import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import {
  reduce,
  type SessionState,
  type SubscriptionMessage,
} from '@yourtechbudstudio/fluidcast-harness/protocol';
import {
  guidedWalkthroughProgressPrompt,
  guidedWalkthroughSummaryPrompt,
} from '@yourtechbudstudio/fluidcast-presets';
import type { TranscriptEntry } from '@yourtechbudstudio/fluidcast-tool-agent';
import { Effect, Exit, Layer, Option, Stream } from 'effect';

import type { FluidcastConfig } from '../../runtime-config/index.js';
import { continueCallLabel, continueMessage } from '../continuation.js';
import { FluidcastSessionUnreadable, FluidcastStartFailed } from '../errors.js';
import type { FluidcastSessionId } from '../ids.js';
import { buildFluidcastModels, type FluidcastModels } from '../models.js';
import {
  buildFluidcastSession,
  type BuiltFluidcastSession,
  type FluidcastSessionInput,
} from '../session-factory.js';
import {
  fakeLanguageModel,
  fakeWorkerType,
  fluidcastConfig,
  silentSpeech,
  type FakeReply,
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
    return {
      exit,
      calls: fake.calls,
      given: recording.given,
      listed: recording.listed,
      http,
      bin,
    };
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

/** Isagi's per-invocation instrumentation in a worker's options: none of it may reach the probe. */
const isagiVariables = (environment: Readonly<Record<string, string | undefined>> | undefined) =>
  Object.keys(environment ?? {}).filter((name) => name.startsWith('ISAGI_'));

const skills = [{ name: 'review', description: 'Review the diff' }];

test("Claude's skills are listed by an uninstrumented probe beside the instrumented worker", async () => {
  const result = await scenario(
    { input: { harnessSessionId: null }, worker: { skills } },
    (built) => Effect.orDie(built.worker.skills),
  );
  assert.ok(Exit.isSuccess(result.exit));
  assert.deepEqual(result.exit.value, skills);
  const [conversation, probe] = result.given.claude;
  assert.ok(conversation && probe);
  assert.deepEqual(isagiVariables(conversation.environment), [
    'ISAGI_AGENT_SESSION_ID',
    'ISAGI_SDK_EXECUTION_ID',
  ]);
  assert.equal(conversation.settings, '/data/claude/settings.json');
  // The probe: same directory and executable, the launch base alone, no hook settings.
  assert.deepEqual(probe, {
    cwd: '/repo',
    executable: join(result.bin, 'claude'),
    environment: { HOME: '/home/dev', PATH: result.bin },
  });
  assert.deepEqual(result.listed, [{ harness: 'claude', index: 1 }]);
  assert.deepEqual(result.calls.listSkills, ['/repo']);
});

test("Codex's skills are listed by an uninstrumented probe beside the instrumented worker", async () => {
  const result = await scenario(
    { input: { harness: 'codex', harnessSessionId: null }, withClaude: false, worker: { skills } },
    (built) => Effect.orDie(built.worker.skills),
  );
  assert.ok(Exit.isSuccess(result.exit));
  assert.deepEqual(result.exit.value, skills);
  const [conversation, probe] = result.given.codex;
  assert.ok(conversation && probe);
  assert.ok(conversation.args && conversation.thread);
  assert.equal(isagiVariables(conversation.environment).length, 2);
  // The probe: same directory, the launch base alone, no hook args or thread.
  assert.deepEqual(probe, { cwd: '/repo', environment: { HOME: '/home/dev', PATH: result.bin } });
  assert.deepEqual(result.listed, [{ harness: 'codex', index: 1 }]);
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

interface RoleScenario {
  readonly history?: FluidcastConfig['history'];
  readonly worker: FakeWorkerOptions;
  /** The voice's replies, by call. */
  readonly voice: (call: number) => FakeReply;
}

/** Each role's prompts so far, flattened to text. */
interface RolePrompts {
  readonly voice: ReadonlyArray<string>;
  readonly base: ReadonlyArray<string>;
  readonly summary: ReadonlyArray<string>;
}

/** A running session, its state as one subscribed client sees it, and each role's prompts. */
interface RoleSession {
  readonly built: BuiltFluidcastSession;
  readonly prompts: RolePrompts;
  /** Polls the state until `done` holds, or fails after `ms`. */
  readonly stateWhere: (
    done: (state: SessionState) => boolean,
    ms?: number,
  ) => Effect.Effect<SessionState>;
}

const summaryText = 'The listener asked about the plan, and the agent read it.';

/**
 * Builds a new session from role-tagged fake models, so a test can tell which role each generation
 * reached, and runs `body` on it inside the session's scope with one client subscribed, as the
 * player is: the session continues after a tool only while a client is subscribed.
 */
async function roleScenario<A>(
  options: RoleScenario,
  body: (session: RoleSession) => Effect.Effect<A>,
) {
  const fake = fakeWorkerType(options.worker);
  const recording = recordingWorkers(fake.worker);
  const config: FluidcastConfig = {
    ...fluidcastConfig(),
    ...(options.history === undefined ? {} : { history: options.history }),
  };
  return withLaunchEnvironment(true, async (launchEnvironment) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const voice = yield* fakeLanguageModel(options.voice);
          const base = yield* fakeLanguageModel(() => ({ text: 'unexpected' }));
          const summary = yield* fakeLanguageModel(() => ({ text: summaryText }));
          const models: FluidcastModels = {
            voice: () => voice.model,
            base: base.model,
            summary: summary.model,
            speech: silentSpeech,
          };
          const built = yield* buildFluidcastSession(
            { ...baseInput, harnessSessionId: null },
            { config, models, workers: recording.workers },
          );
          let latest: SessionState | undefined;
          yield* Effect.forkScoped(
            Stream.runForEach(built.session.subscribe(), (message) =>
              Effect.sync(() => {
                if (message._tag === 'Snapshot') latest = message.state;
                else if (message._tag !== 'Superseded' && latest !== undefined)
                  latest = reduce(latest, message);
              }),
            ),
          );
          const stateWhere = (done: (state: SessionState) => boolean, ms = 5_000) =>
            Effect.gen(function* () {
              for (let waited = 0; ; waited += 10) {
                const state = latest;
                if (state !== undefined && done(state)) return state;
                if (waited >= ms) {
                  return yield* Effect.die(new Error('the session never reached the state'));
                }
                yield* Effect.sleep('10 millis');
              }
            });
          const prompts = { voice: voice.prompts, base: base.prompts, summary: summary.prompts };
          return { value: yield* body({ built, prompts, stateWhere }), prompts };
        }),
      ).pipe(Effect.provide(Layer.mergeAll(launchEnvironment, stubRegistry()))),
    ),
  );
}

const forward: FakeReply = { text: '[{"type":"forward_agent"}]', inputTokens: 5_000 };
const quiet: FakeReply = { text: '[]', inputTokens: 5_000 };
/** Each message is forwarded, and the forward's result answered with nothing more. */
const forwardEachMessage = (call: number) => (call % 2 === 0 ? forward : quiet);

/**
 * Two exchanges, each sent once the previous one has settled, so the second forward has earlier
 * history to summarize. Returns the state after the last reply.
 */
const runTwoExchanges = ({ built, prompts, stateWhere }: RoleSession) =>
  Effect.gen(function* () {
    const settled = (calls: number) =>
      stateWhere(
        (state) =>
          prompts.voice.length >= calls &&
          state.generation === 'idle' &&
          state.pendingResults.length === 0 &&
          state.executions.length === 0,
      );
    yield* Effect.orDie(built.session.command({ _tag: 'SendMessage', text: 'Explain the plan.' }));
    yield* settled(2);
    yield* Effect.orDie(built.session.command({ _tag: 'SendMessage', text: 'And the risks?' }));
    return yield* settled(4);
  });

const isSummary = (prompt: string) => prompt.includes(guidedWalkthroughSummaryPrompt);
const isProgress = (prompt: string) => prompt.includes(guidedWalkthroughProgressPrompt);

test('with compaction enabled, the summary model writes the summary the voice then reads', async () => {
  const { value: state, prompts } = await roleScenario(
    {
      history: { compaction: { enabled: true, aboveInputTokens: 1_000 } },
      worker: { answer: {} },
      voice: forwardEachMessage,
    },
    runTwoExchanges,
  );
  const compaction = state.actions.find((action) => action.type === 'history_compaction');
  assert.ok(compaction, 'no history_compaction action was appended');
  assert.equal(compaction.text, summaryText);
  assert.ok(prompts.summary.some(isSummary));
  assert.ok(prompts.voice.at(-1)!.includes(summaryText), 'the voice never read the summary');
  assert.equal(prompts.voice.some(isSummary), false);
  assert.deepEqual(prompts.base, []);
});

test('without compaction enabled, no summary is written', async () => {
  for (const history of [undefined, { compaction: { enabled: false, aboveInputTokens: 1_000 } }]) {
    const { value: state, prompts } = await roleScenario(
      {
        ...(history === undefined ? {} : { history }),
        worker: { answer: {} },
        voice: forwardEachMessage,
      },
      runTwoExchanges,
    );
    assert.equal(
      state.actions.some((action) => action.type === 'history_compaction'),
      false,
    );
    assert.equal(prompts.summary.some(isSummary), false);
  }
});

test("the Forward tool's progress sentences come from the summary model, not the voice's", async () => {
  // The SDK's first progress tick is at 10 seconds; the worker stays busy past it.
  const { prompts } = await roleScenario(
    { worker: { answer: { after: '11 seconds' } }, voice: () => forward },
    (session) =>
      Effect.gen(function* () {
        yield* Effect.orDie(
          session.built.session.command({ _tag: 'SendMessage', text: 'Explain.' }),
        );
        for (let waited = 0; !session.prompts.summary.some(isProgress); waited += 50) {
          if (waited >= 15_000) return yield* Effect.die(new Error('no progress was written'));
          yield* Effect.sleep('50 millis');
        }
      }),
  );
  assert.ok(prompts.summary.some(isProgress));
  assert.deepEqual(prompts.base, []);
  assert.equal(prompts.voice.some(isProgress), false);
});
