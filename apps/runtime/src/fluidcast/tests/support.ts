import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SpeechError } from '@yourtechbudstudio/fluidcast-core/speech';
import { ToolFault, type Session } from '@yourtechbudstudio/fluidcast-harness';
import {
  CommandRejected,
  SpeechNotFound,
  ToolCommandRejected,
  type Command,
  type SubscriptionMessage,
} from '@yourtechbudstudio/fluidcast-harness/protocol';
import {
  WorkerSetupError,
  type TranscriptEntry,
  type WorkerHandle,
  type WorkerType,
} from '@yourtechbudstudio/fluidcast-tool-agent';
import type { ClaudeWorkerOptions } from '@yourtechbudstudio/fluidcast-tool-agent/claude';
import type { CodexWorkerOptions } from '@yourtechbudstudio/fluidcast-tool-agent/codex';
import {
  SkillsUnavailable,
  type Skill,
  type TranscriptMessage,
  type WorkerSummary,
} from '@yourtechbudstudio/fluidcast-tool-agent/schema';
import {
  Context,
  Deferred,
  type Duration,
  Effect,
  Layer,
  Redacted,
  Ref,
  Stream,
  SubscriptionRef,
} from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';

import { apiBasePath } from '@isagi/contracts';

import {
  AgentSessionArtifacts,
  HarnessAdapterError,
  HarnessAdapterRegistry,
} from '../../harnesses/index.js';
import { AgentSessionArtifactError } from '../../harnesses/testing.js';
import { publishOnlyRecordingEventBus } from '../../platform/events/testing.js';
import { withListeningServer } from '../../platform/http/testing.js';
import { LaunchEnvironment } from '../../pty-processes/index.js';
import {
  RuntimeConfig,
  type FluidcastConfig,
  type FluidcastConfigState,
} from '../../runtime-config/index.js';
import { defaultRuntimeConfig } from '../../runtime-config/testing.js';
import { registerFluidcastRoutes } from '../api.js';
import { FluidcastSessionUnreadable } from '../errors.js';
import type { FluidcastSessionId } from '../ids.js';
import type {
  BuiltFluidcastSession,
  FluidcastSessionInput,
  FluidcastWorkers,
} from '../session-factory.js';
import {
  FluidcastSessions,
  makeFluidcastSessions,
  type FluidcastSessionBuilder,
} from '../sessions.service.js';

/** A Fluidcast config with fake keys; nothing in these tests reaches a real service. */
export function fluidcastConfig(
  languageModel: Partial<FluidcastConfig['languageModel']> = {},
): FluidcastConfig {
  return {
    enabled: true,
    languageModel: {
      provider: 'openai-compatible',
      model: 'test-model',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: Redacted.make('sk-test'),
      ...languageModel,
    } as FluidcastConfig['languageModel'],
    speech: { model: 'tts-test', apiKey: Redacted.make('sk-test'), format: 'opus' },
    preset: { profile: 'compact', voice: { name: 'alloy' } },
  };
}

/**
 * An `HttpClient` that answers every language-model request with one empty streamed reply and
 * records each request's JSON body, so a test can see what reached the network.
 */
export function recordingHttpClient() {
  const bodies: Array<Record<string, unknown>> = [];
  const chunk = {
    id: 'c',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { content: '[]' }, finish_reason: 'stop' }],
  };
  const client = HttpClient.make((request) => {
    if (request.body._tag === 'Uint8Array') {
      bodies.push(
        JSON.parse(new TextDecoder().decode(request.body.body)) as Record<string, unknown>,
      );
    }
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        }),
      ),
    );
  });
  return { bodies, layer: Layer.succeed(HttpClient.HttpClient, client) };
}

export interface FakeWorkerOptions {
  /** The attached session's history; `attach` fails with this reason instead when set. */
  readonly history?: ReadonlyArray<TranscriptEntry>;
  readonly attachFails?: 'SessionNotFound' | 'SessionUnreadable';
  /** What listing skills returns, or why it fails; no skills by default. */
  readonly skills?: ReadonlyArray<Skill> | SkillsUnavailable['reason'];
}

/**
 * A worker type that never starts a process: attach returns `history`, a connection idles, and
 * listing returns `skills`. Each call is recorded, listing by the `cwd` it was given.
 */
export function fakeWorkerType(options: FakeWorkerOptions = {}) {
  const calls = { attach: [] as string[], connect: 0, listSkills: [] as string[] };
  const skills = options.skills ?? [];
  const worker: WorkerType = {
    cwd: '/repo',
    composeMessage: (prompt) => prompt,
    attach: (sessionId) => {
      calls.attach.push(sessionId);
      return options.attachFails === undefined
        ? Effect.succeed({ cwd: '/repo', history: options.history ?? [] })
        : Effect.fail(new WorkerSetupError({ sessionId, reason: options.attachFails }));
    },
    connect: () => {
      calls.connect += 1;
      return Stream.never;
    },
    listSkills: (cwd) => {
      calls.listSkills.push(cwd);
      return typeof skills === 'string'
        ? Effect.fail(new SkillsUnavailable({ reason: skills }))
        : Effect.succeed(skills);
    },
  };
  return { worker, calls };
}

/**
 * Workers that record the options each harness was given and return `worker`. `listed` records
 * which made worker served each skill listing, by its index in `given`.
 */
export function recordingWorkers(worker: WorkerType) {
  const given: { claude: ClaudeWorkerOptions[]; codex: CodexWorkerOptions[] } = {
    claude: [],
    codex: [],
  };
  const listed: Array<{ readonly harness: 'claude' | 'codex'; readonly index: number }> = [];
  const made = (harness: 'claude' | 'codex', index: number): WorkerType => ({
    ...worker,
    listSkills: (cwd) =>
      Effect.suspend(() => {
        listed.push({ harness, index });
        return worker.listSkills(cwd);
      }),
  });
  const workers: FluidcastWorkers = {
    claude: (options) => made('claude', given.claude.push(options) - 1),
    codex: (options) => made('codex', given.codex.push(options) - 1),
  };
  return { workers, given, listed };
}

/** Instrumentation as the real adapters shape it, without touching a data root. */
export function stubRegistry(options: { readonly fails?: boolean } = {}) {
  return Layer.succeed(
    HarnessAdapterRegistry,
    HarnessAdapterRegistry.of({
      buildLaunch: () => Effect.die('not used'),
      buildHeadlessLaunch: () => Effect.die('not used'),
      supportsSdk: (harness): harness is 'claude' | 'codex' =>
        harness === 'claude' || harness === 'codex',
      buildSdkInstrumentation: (input) => {
        if (options.fails) {
          return Effect.fail(
            new HarnessAdapterError('artifact_write_failed', 'instrumentation failed'),
          );
        }
        const environment = {
          ISAGI_AGENT_SESSION_ID: String(input.agentSessionId),
          ISAGI_SDK_EXECUTION_ID: input.executionId,
        };
        return Effect.succeed(
          input.harness === 'claude'
            ? { harness: 'claude', environment, settingsPath: '/data/claude/settings.json' }
            : {
                harness: 'codex',
                environment,
                args: { beforeSubcommand: ['--enable', 'hooks'], appServer: ['-c', 'x=1'] },
                thread: { config: { bypass_hook_trust: true }, sessionStartSource: 'startup' },
              },
        );
      },
    }),
  );
}

/** A launch base whose `PATH` holds an executable `claude` unless `withClaude` is false. */
export function withLaunchEnvironment<A>(
  withClaude: boolean,
  run: (layer: Layer.Layer<LaunchEnvironment>, binDirectory: string) => Promise<A>,
): Promise<A> {
  const bin = mkdtempSync(join(tmpdir(), 'isagi-fluidcast-bin-'));
  if (withClaude) {
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\n', 'utf8');
    chmodSync(join(bin, 'claude'), 0o755);
  }
  const layer = Layer.succeed(
    LaunchEnvironment,
    LaunchEnvironment.of({ base: Effect.succeed({ HOME: '/home/dev', PATH: bin }) }),
  );
  return run(layer, bin).finally(() => rmSync(bin, { recursive: true, force: true }));
}

/** An empty Harness state, as a fresh session's first snapshot carries it. */
export const emptySessionState = {
  actions: [],
  cursor: 0,
  generation: 'idle',
  playback: null,
  executions: [],
  pendingResults: [],
  pendingProgress: [],
  replay: null,
  start: null,
  started: null,
  paused: false,
  speakers: [{ id: 'host', name: 'Host' }],
  speech: { mimeType: 'audio/ogg' },
} as const;

/**
 * A built session whose Harness and worker the test drives: commands are recorded (`Start` and a
 * `ToolCommand` are refused, `Next` runs until interrupted), speech is fixed per action ID, and the
 * worker's status, transcript, skills, fault and native ID are set by the test. Closing the session's scope is recorded too.
 */
export function fakeBuiltSession() {
  const commands: Command[] = [];
  const status = Effect.runSync(
    SubscriptionRef.make<WorkerSummary>({
      _tag: 'WorkerSummary',
      status: 'idle',
      sessionId: null,
      backgroundTasks: 0,
    }),
  );
  const transcript = Effect.runSync(
    SubscriptionRef.make<TranscriptMessage>({ _tag: 'TranscriptSnapshot', entries: [] }),
  );
  let skills: Effect.Effect<ReadonlyArray<Skill>, SkillsUnavailable> = Effect.succeed([]);
  const nativeId = Ref.makeUnsafe<string | null>(null);
  const fault = Deferred.makeUnsafe<ToolFault>();
  const state = {
    closed: false,
    commandStarted: false,
    commandInterrupted: false,
    /** Subscriptions currently open on the worker's status and transcript. */
    open: { status: 0, transcript: 0 },
  };
  const tracked = <A>(feed: 'status' | 'transcript', stream: Stream.Stream<A>) =>
    Stream.unwrap(
      Effect.sync(() => {
        state.open[feed] += 1;
        return stream;
      }),
    ).pipe(Stream.ensuring(Effect.sync(() => void (state.open[feed] -= 1))));
  const session: Session['Service'] = {
    subscribe: () =>
      Stream.make({ _tag: 'Snapshot', state: emptySessionState } as SubscriptionMessage).pipe(
        Stream.concat(Stream.never),
      ),
    command: (command) => {
      if (command._tag === 'Start') {
        return Effect.fail(new CommandRejected({ command: 'Start', phase: 'idle' }));
      }
      if (command._tag === 'Next') {
        // A command that runs until something interrupts it.
        return Effect.sync(() => {
          state.commandStarted = true;
        }).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              state.commandInterrupted = true;
            }),
          ),
        );
      }
      if (command._tag === 'ToolCommand') {
        return Effect.fail(
          new ToolCommandRejected({ executionId: command.executionId, reason: 'stale' }),
        );
      }
      return Effect.sync(() => void commands.push(command));
    },
    speech: (actionId) => {
      if (actionId === 'missing') return Stream.fail(new SpeechNotFound({ actionId }));
      if (actionId === 'broken') return Stream.fail(new SpeechError({ reason: 'RequestError' }));
      return Stream.make(new TextEncoder().encode(`audio for ${actionId}`));
    },
  };
  const worker: WorkerHandle = {
    status: tracked('status', SubscriptionRef.changes(status)),
    transcript: tracked('transcript', SubscriptionRef.changes(transcript)),
    skills: Effect.suspend(() => skills),
    fault: Deferred.await(fault),
    sessionId: Ref.get(nativeId),
  };
  return {
    built: { session, worker } satisfies BuiltFluidcastSession,
    commands,
    state,
    /** The worker reports its native ID, as `SessionStarted` does. */
    reportNativeId: (id: string) =>
      Effect.runSync(
        Effect.andThen(
          Ref.set(nativeId, id),
          SubscriptionRef.set(status, {
            _tag: 'WorkerSummary',
            status: 'working',
            sessionId: id,
            backgroundTasks: 0,
          }),
        ),
      ),
    /** Records the ID without publishing it, like a `SessionStarted` whose status update has not run yet. */
    reportNativeIdSilently: (id: string) => Effect.runSync(Ref.set(nativeId, id)),
    /** Publishes one transcript message, as the worker does on each change. */
    appendTranscript: (message: TranscriptMessage) =>
      Effect.runSync(SubscriptionRef.set(transcript, message)),
    /** Replaces what the worker's skill listing does from now on. */
    listSkillsWith: (listing: Effect.Effect<ReadonlyArray<Skill>, SkillsUnavailable>) => {
      skills = listing;
    },
    faultWith: (reason: string) =>
      Effect.runSync(Deferred.succeed(fault, new ToolFault({ reason }))),
  };
}

export type FakeBuiltSession = ReturnType<typeof fakeBuiltSession>;

export interface ServedFakeSession {
  readonly sessions: FluidcastSessions['Service'];
  readonly fake: FakeBuiltSession;
  readonly fluidcastSessionId: FluidcastSessionId;
  /** `<origin>/api/v1/fluidcast-sessions/<id>` for the started session. */
  readonly base: string;
}

/** Starts one fake session and serves the Fluidcast routes over a real socket. */
export function serveFakeSession(run: (served: ServedFakeSession) => Promise<void>) {
  const fake = fakeBuiltSession();
  const fixture = fakeSessionsLayer({ fakes: [fake] });
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sessions = Context.get(yield* Layer.build(fixture.layer), FluidcastSessions);
        const { fluidcastSessionId } = yield* sessions.start({
          agentSessionId: 7,
          harness: 'codex',
          cwd: '/repo',
          harnessSessionId: null,
        });
        yield* Effect.promise(() =>
          withListeningServer(
            Layer.succeed(FluidcastSessions, sessions),
            registerFluidcastRoutes,
            (server) =>
              run({
                sessions,
                fake,
                fluidcastSessionId,
                base: `${server.origin}${apiBasePath}/fluidcast-sessions/${fluidcastSessionId}`,
              }),
          ),
        );
      }),
    ),
  );
}

/** Reads SSE `data:` payloads until `count` arrived, leaving the stream open. */
export async function readEvents(body: ReadableStream<Uint8Array>, count: number) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const events = () =>
    [...text.matchAll(/^data: (.*)$/gm)].map((match) => JSON.parse(match[1]!) as unknown);
  while (events().length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return { events: events(), reader };
}

/**
 * `FluidcastSessions` over a builder that hands out the given fakes in order, with config `state`,
 * recording events and native-ID writes. Build failures can be scripted per start.
 */
export function fakeSessionsLayer(options: {
  readonly fakes: ReadonlyArray<FakeBuiltSession | 'unreadable'>;
  /** Builds every session instead of `fakes`, for tests that need a real Harness. */
  readonly builder?: FluidcastSessionBuilder;
  readonly state?: FluidcastConfigState;
  readonly writeFails?: boolean;
  /** The launch environment that `env.NAME` keys resolve against; empty by default. */
  readonly environment?: NodeJS.ProcessEnv;
  /** Replaces the 60 s build bound, so a hung build can time out within a test. */
  readonly buildTimeout?: Duration.Input;
}) {
  const events = publishOnlyRecordingEventBus('FluidcastSessions does not subscribe');
  const writes: Array<{ agentSessionId: number; harnessSessionId: string }> = [];
  const built: FluidcastSessionInput[] = [];
  let next = 0;
  const build: FluidcastSessionBuilder = (input) =>
    Effect.gen(function* () {
      built.push(input);
      const fake = options.fakes[next++];
      if (fake === undefined) return yield* Effect.die('no more fake sessions');
      if (fake === 'unreadable') {
        return yield* new FluidcastSessionUnreadable({ reason: 'SessionNotFound' });
      }
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          fake.state.closed = true;
        }),
      );
      return fake.built;
    });
  const layer = Layer.effect(
    FluidcastSessions,
    makeFluidcastSessions(
      options.builder ?? build,
      options.buildTimeout === undefined ? undefined : { buildTimeout: options.buildTimeout },
    ),
  ).pipe(
    Layer.provide([
      Layer.succeed(RuntimeConfig, {
        get: Effect.succeed({
          ...defaultRuntimeConfig,
          fluidcast: options.state ?? { status: 'ready', config: fluidcastConfig() },
        }),
        acceptHarnessPolicy: () => Effect.die('not used'),
      }),
      Layer.mock(AgentSessionArtifacts)({
        paths: () => ({ directory: '/data', metadataPath: '/data/metadata.json' }),
        writeHarnessSessionId: (input) =>
          options.writeFails
            ? Effect.fail(
                new AgentSessionArtifactError({
                  code: 'metadata_write_failed',
                  agentSessionId: input.agentSessionId,
                  path: '/data/metadata.json',
                  cause: new Error('disk full'),
                }),
              )
            : Effect.sync(() => void writes.push(input)),
      }),
      events.layer,
      stubRegistry(),
      Layer.succeed(
        LaunchEnvironment,
        LaunchEnvironment.of({ base: Effect.succeed(options.environment ?? {}) }),
      ),
    ]),
  );
  return { layer, events: events.events, writes, built };
}

/**
 * An `HttpClient` whose language-model replies never send a byte, and whose cleanup, when a
 * generation is cancelled, takes `cleanupMs`. `requested` resolves on the first request.
 */
export function hangingHttpClient(cleanupMs: number) {
  let markRequested: () => void = () => {};
  const requested = new Promise<void>((resolve) => (markRequested = resolve));
  const client = HttpClient.make((request) => {
    markRequested();
    const body = new ReadableStream<Uint8Array>({
      cancel: () => new Promise((resolve) => setTimeout(resolve, cleanupMs)),
    });
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
      ),
    );
  });
  return { requested, layer: Layer.succeed(HttpClient.HttpClient, client) };
}
