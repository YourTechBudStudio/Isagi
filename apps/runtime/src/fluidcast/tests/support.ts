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
import type {
  TranscriptMessage,
  WorkerSummary,
} from '@yourtechbudstudio/fluidcast-tool-agent/schema';
import {
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

import {
  AgentSessionArtifacts,
  HarnessAdapterError,
  HarnessAdapterRegistry,
} from '../../harnesses/index.js';
import { AgentSessionArtifactError } from '../../harnesses/testing.js';
import { publishOnlyRecordingEventBus } from '../../platform/events/testing.js';
import { LaunchEnvironment } from '../../pty-processes/index.js';
import {
  RuntimeConfig,
  type FluidcastConfig,
  type FluidcastConfigState,
} from '../../runtime-config/index.js';
import { defaultRuntimeConfig } from '../../runtime-config/testing.js';
import { FluidcastSessionUnreadable } from '../errors.js';
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
}

/** A worker type that never starts a process: attach returns `history`, and a connection idles. */
export function fakeWorkerType(options: FakeWorkerOptions = {}) {
  const calls = { attach: [] as string[], connect: 0 };
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
  };
  return { worker, calls };
}

/** Workers that record the options each harness was given and return `worker`. */
export function recordingWorkers(worker: WorkerType) {
  const given: { claude: ClaudeWorkerOptions[]; codex: CodexWorkerOptions[] } = {
    claude: [],
    codex: [],
  };
  const workers: FluidcastWorkers = {
    claude: (options) => {
      given.claude.push(options);
      return worker;
    },
    codex: (options) => {
      given.codex.push(options);
      return worker;
    },
  };
  return { workers, given };
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
  paused: false,
  speakers: [{ id: 'host', name: 'Host' }],
  speech: { mimeType: 'audio/ogg' },
} as const;

/**
 * A built session whose Harness and worker the test drives: commands are recorded (`Start` and a
 * `ToolCommand` are refused, `Next` runs until interrupted), speech is fixed per action ID, and the worker's status, fault and
 * native ID are set by the test. Closing the session's scope is recorded too.
 */
export function fakeBuiltSession() {
  const commands: Command[] = [];
  const status = Effect.runSync(
    SubscriptionRef.make<WorkerSummary>({ _tag: 'WorkerSummary', status: 'idle', sessionId: null }),
  );
  const nativeId = Ref.makeUnsafe<string | null>(null);
  const fault = Deferred.makeUnsafe<ToolFault>();
  const state = { closed: false, commandStarted: false, commandInterrupted: false };
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
    status: SubscriptionRef.changes(status),
    transcript: Stream.make({ _tag: 'TranscriptSnapshot', entries: [] } as TranscriptMessage).pipe(
      Stream.concat(Stream.never),
    ),
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
          SubscriptionRef.set(status, { _tag: 'WorkerSummary', status: 'working', sessionId: id }),
        ),
      ),
    /** Records the ID without publishing it, like a `SessionStarted` whose status update has not run yet. */
    reportNativeIdSilently: (id: string) => Effect.runSync(Ref.set(nativeId, id)),
    faultWith: (reason: string) =>
      Effect.runSync(Deferred.succeed(fault, new ToolFault({ reason }))),
  };
}

export type FakeBuiltSession = ReturnType<typeof fakeBuiltSession>;

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
      Layer.succeed(LaunchEnvironment, LaunchEnvironment.of({ base: Effect.succeed({}) })),
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
