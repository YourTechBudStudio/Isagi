import { outputJsonSchema } from '@yourtechbudstudio/fluidcast-core/generation';
import { SpeechSynthesizer } from '@yourtechbudstudio/fluidcast-core/speech';
import {
  layer as harnessLayer,
  Session,
  type SessionConfig,
} from '@yourtechbudstudio/fluidcast-harness';
import {
  guidedWalkthrough,
  guidedWalkthroughProgressPrompt,
} from '@yourtechbudstudio/fluidcast-presets';
import {
  forwardAgentTool,
  type WorkerHandle,
  type WorkerType,
} from '@yourtechbudstudio/fluidcast-tool-agent';
import {
  claudeWorker,
  type ClaudeWorkerOptions,
} from '@yourtechbudstudio/fluidcast-tool-agent/claude';
import {
  codexWorker,
  type CodexWorkerOptions,
} from '@yourtechbudstudio/fluidcast-tool-agent/codex';
import { askTool } from '@yourtechbudstudio/fluidcast-tool-ask';
import { showTool } from '@yourtechbudstudio/fluidcast-tool-show';
import { Context, Effect, Layer, Option, type Scope, Stream } from 'effect';
import { LanguageModel } from 'effect/ai';

import {
  harnessDefinition,
  HarnessAdapterRegistry,
  type SdkHarness,
  type SdkInstrumentation,
} from '../harnesses/index.js';
import { resolveExecutableOnPath } from '../platform/process/index.js';
import { LaunchEnvironment } from '../pty-processes/index.js';
import type { FluidcastConfig } from '../runtime-config/index.js';
import { withAnthropicStructuredOutput } from './anthropic-structured-output.js';
import { continueStart, lastAnswer } from './continuation.js';
import { FluidcastSessionUnreadable, FluidcastStartFailed } from './errors.js';
import type { FluidcastSessionId } from './ids.js';
import type { FluidcastModels } from './models.js';
import { withStructuredOutput } from './structured-output.js';

export interface FluidcastSessionInput {
  readonly agentSessionId: number;
  readonly fluidcastSessionId: FluidcastSessionId;
  readonly harness: SdkHarness;
  /** Where a new worker runs; an attached session runs in its own recorded directory. */
  readonly cwd: string;
  /** The agent's native session to continue, or `null` for a new one. */
  readonly harnessSessionId: string | null;
}

export interface BuiltFluidcastSession {
  readonly session: Session['Service'];
  readonly worker: WorkerHandle;
}

/**
 * How a worker type is made for each harness. Production uses the SDK's workers; the module's
 * tests pass fakes. Internal: not exported from the module index.
 */
export interface FluidcastWorkers {
  readonly claude: (options: ClaudeWorkerOptions) => WorkerType;
  readonly codex: (options: CodexWorkerOptions) => WorkerType;
}

export const sdkWorkers: FluidcastWorkers = { claude: claudeWorker, codex: codexWorker };

export interface FluidcastSessionDependencies {
  readonly config: FluidcastConfig;
  readonly models: FluidcastModels;
  readonly workers: FluidcastWorkers;
}

/**
 * Builds one Fluidcast session in the caller's scope, which owns everything it starts: the worker
 * first, then the Harness, so the Harness is torn down first.
 *
 * The worker is the harness's own SDK worker, instrumented per invocation exactly as the PTY is
 * (ADR 0007), in the environment Isagi gives every launched process. With a native session ID the
 * worker attaches to that conversation; if the conversation has an answer, the session opens on a
 * continuation start that waits for a tap, and otherwise on the composer. Without an ID the first
 * forward starts a new native session. No model or effort is passed: the agent keeps its own. Isagi
 * adds no modifier of its own; a skill the listener types as `/name` passes through to the worker.
 */
export const buildFluidcastSession = (
  input: FluidcastSessionInput,
  dependencies: FluidcastSessionDependencies,
): Effect.Effect<
  BuiltFluidcastSession,
  FluidcastSessionUnreadable | FluidcastStartFailed,
  Scope.Scope | HarnessAdapterRegistry | LaunchEnvironment
> =>
  Effect.gen(function* () {
    const { config, models, workers } = dependencies;
    const registry = yield* HarnessAdapterRegistry;
    const instrumentation = yield* registry
      .buildSdkInstrumentation({
        agentSessionId: input.agentSessionId,
        harness: input.harness,
        executionId: input.fluidcastSessionId,
      })
      .pipe(Effect.mapError(() => new FluidcastStartFailed({ reason: 'instrumentation_failed' })));
    const base = yield* (yield* LaunchEnvironment).base;
    const environment = { ...base, ...instrumentation.environment };
    const worker = yield* workerType(input, instrumentation, { base, environment }, workers);

    const tool = yield* forwardAgentTool({
      worker,
      ...(input.harnessSessionId === null
        ? {}
        : { session: { sessionId: input.harnessSessionId } }),
      progress: { prompt: guidedWalkthroughProgressPrompt },
    }).pipe(
      Effect.provideService(LanguageModel.LanguageModel, models.languageModel),
      Effect.mapError((error) => new FluidcastSessionUnreadable({ reason: error.reason })),
    );

    const answer =
      input.harnessSessionId === null
        ? undefined
        : Option.getOrUndefined(
            Option.flatMap(yield* Stream.runHead(tool.worker.transcript), (message) =>
              message._tag === 'TranscriptSnapshot'
                ? Option.fromNullishOr(lastAnswer(message.entries))
                : Option.none(),
            ),
          );
    const { name, instructions } = config.preset.voice;
    const preset = guidedWalkthrough({
      profile: config.preset.profile,
      voice: { name, ...(instructions === undefined ? {} : { instructions }) },
    });
    const sessionConfig: SessionConfig = {
      ...preset,
      speechFormat: config.speech.format,
      tools: [showTool(), askTool(), tool.tool],
      ...(answer === undefined ? {} : { start: continueStart(answer) }),
    };

    // The schema is built once per session, from the same speakers and tools as the prompt.
    const outputSchema = () =>
      outputJsonSchema({ speakers: sessionConfig.speakers, tools: sessionConfig.tools });
    const voice =
      models.structuredOutput === 'openai-compatible'
        ? withStructuredOutput(models.languageModel, outputSchema())
        : models.structuredOutput === 'anthropic'
          ? withAnthropicStructuredOutput(models.languageModel, outputSchema())
          : models.languageModel;
    // Built fresh per session: layers are memoized by identity.
    const context = yield* Layer.build(
      harnessLayer(sessionConfig).pipe(
        Layer.provide([
          Layer.succeed(LanguageModel.LanguageModel, voice),
          Layer.succeed(SpeechSynthesizer, models.speech),
        ]),
      ),
    ).pipe(
      // The Harness checks its configuration when it builds and dies on a defect there.
      Effect.catchDefect(() =>
        Effect.fail(new FluidcastStartFailed({ reason: 'session_build_failed' })),
      ),
    );
    return { session: Context.get(context, Session), worker: tool.worker };
  });

/**
 * The harness's worker, instrumented per invocation, with its skill listing served by an
 * uninstrumented probe of the same kind. Listing skills starts a short-lived query or app-server
 * that is a probe, not a conversation (ADR 0007): built from the base environment with no hook
 * settings, args or thread, it cannot write to the agent session's hook ledger or disturb native
 * session ID capture. Skills, `isagi-docs` included, live in the harness's user directory, so the
 * probe still sees them.
 */
function workerType(
  input: FluidcastSessionInput,
  instrumentation: SdkInstrumentation,
  environments: { readonly base: NodeJS.ProcessEnv; readonly environment: NodeJS.ProcessEnv },
  workers: FluidcastWorkers,
): Effect.Effect<WorkerType, FluidcastStartFailed> {
  const { base, environment } = environments;
  switch (instrumentation.harness) {
    case 'claude':
      // The SDK needs an absolute path, and must never fall back to its bundled Claude Code.
      return resolveExecutableOnPath(harnessDefinition('claude').executable, environment.PATH).pipe(
        Effect.mapError(() => new FluidcastStartFailed({ reason: 'executable_not_found' })),
        Effect.map((executable) => ({
          ...workers.claude({
            cwd: input.cwd,
            executable,
            permissionMode: 'auto',
            environment,
            settings: instrumentation.settingsPath,
          }),
          listSkills: workers.claude({ cwd: input.cwd, executable, environment: base }).listSkills,
        })),
      );
    case 'codex':
      // A bare name: the worker resolves it on the environment's PATH when it launches. The probe
      // reads the user's plain Codex config, where their skills live; it needs no hook trust.
      return Effect.succeed({
        ...workers.codex({
          cwd: input.cwd,
          environment,
          args: instrumentation.args,
          thread: instrumentation.thread,
        }),
        listSkills: workers.codex({ cwd: input.cwd, environment: base }).listSkills,
      });
  }
}
