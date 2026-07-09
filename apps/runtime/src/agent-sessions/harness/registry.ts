import { Context, Effect, Layer } from 'effect';

import type { AgentHarness } from '@isagi/contracts';

import { DataDirectory } from '../../persistence/index.js';
import type { LaunchPtyProcessInput } from '../../pty-processes/types.js';
import { prepareHarnessIntegrationArtifacts } from './artifacts.js';
import { buildClaudeHeadlessLaunch, buildClaudeLaunch } from './claude/adapter.js';
import { buildCodexHeadlessLaunch, buildCodexLaunch } from './codex/adapter.js';
import { AgentSessionArtifacts } from './ledger.js';
import { buildOpenCodeHeadlessLaunch, buildOpenCodeLaunch } from './opencode/adapter.js';
import { buildPiHeadlessLaunch, buildPiLaunch } from './pi/adapter.js';
import {
  HarnessAdapterError,
  type HarnessHeadlessLaunchContext,
  type HarnessLaunchContext,
} from './types.js';

export interface HarnessAdapterRegistryService {
  readonly buildLaunch: (
    input: HarnessLaunchContext,
  ) => Effect.Effect<LaunchPtyProcessInput, HarnessAdapterError>;
  readonly buildHeadlessLaunch: (
    input: HarnessHeadlessLaunchContext,
  ) => Effect.Effect<LaunchPtyProcessInput, HarnessAdapterError>;
}

export const HarnessAdapterRegistry = Context.GenericTag<HarnessAdapterRegistryService>(
  'isagi/HarnessAdapterRegistry',
);

export const HarnessAdapterRegistryLive = Layer.effect(
  HarnessAdapterRegistry,
  Effect.gen(function* () {
    const directory = yield* DataDirectory;
    const sessionArtifacts = yield* AgentSessionArtifacts;
    const artifacts = yield* prepareHarnessIntegrationArtifacts(directory.paths.root);

    const adapterFactories = {
      pi: (input) =>
        withRuntimeUrl((runtimeUrl) =>
          buildPiLaunch(input, {
            extensionPath: artifacts.piExtensionPath,
            skillDirectory: artifacts.configureIsagiSkill.skillDirectory,
            artifacts: sessionArtifacts,
            runtimeUrl,
          }),
        ),
      opencode: (input) =>
        withRuntimeUrl((runtimeUrl) =>
          buildOpenCodeLaunch(input, {
            pluginPath: artifacts.opencodePluginPath,
            skillScanDirectory: artifacts.configureIsagiSkill.skillScanDirectory,
            artifacts: sessionArtifacts,
            runtimeUrl,
          }),
        ),
      claude: (input) =>
        withRuntimeUrl((runtimeUrl) =>
          buildClaudeLaunch(input, {
            settingsPath: artifacts.claudeSettingsPath,
            skillWorkspaceDirectory: artifacts.configureIsagiSkill.claudeSkillWorkspaceDirectory,
            artifacts: sessionArtifacts,
            runtimeUrl,
          }),
        ),
      codex: (input) =>
        withRuntimeUrl((runtimeUrl) =>
          buildCodexLaunch(input, {
            hookPath: artifacts.codexHookPath,
            artifacts: sessionArtifacts,
            runtimeUrl,
          }),
        ),
    } satisfies Record<
      AgentHarness,
      (input: HarnessLaunchContext) => Effect.Effect<LaunchPtyProcessInput, HarnessAdapterError>
    >;
    const headlessAdapterFactories = {
      pi: (input) => buildPiHeadlessLaunch(input),
      opencode: (input) => buildOpenCodeHeadlessLaunch(input),
      claude: (input) => buildClaudeHeadlessLaunch(input),
      codex: (input) => buildCodexHeadlessLaunch(input),
    } satisfies Record<
      AgentHarness,
      (
        input: HarnessHeadlessLaunchContext,
      ) => Effect.Effect<LaunchPtyProcessInput, HarnessAdapterError>
    >;

    return {
      buildLaunch: (input) =>
        Effect.gen(function* () {
          const build = adapterFactories[input.harness];
          if (!build) {
            console.warn('[runtime] Harness launch rejected: unsupported harness adapter', {
              agentSessionId: input.agentSessionId,
              harness: input.harness,
              cwd: input.cwd,
              latestHarnessSessionId: input.latestHarnessSessionId,
            });
            return yield* Effect.fail(
              new HarnessAdapterError(
                'unsupported_harness',
                `Harness ${input.harness} is not wired for Isagi restoration yet.`,
              ),
            );
          }
          return yield* build(input);
        }),
      buildHeadlessLaunch: (input) =>
        Effect.gen(function* () {
          const build = headlessAdapterFactories[input.harness];
          if (!build) {
            console.warn('[runtime] Headless harness launch rejected: unsupported adapter', {
              harness: input.harness,
              cwd: input.cwd,
            });
            return yield* Effect.fail(
              new HarnessAdapterError(
                'unsupported_harness',
                `Harness ${input.harness} is not wired for Isagi headless agent runs yet.`,
              ),
            );
          }
          return yield* build(input);
        }),
    } satisfies HarnessAdapterRegistryService;
  }),
);

function withRuntimeUrl(
  build: (runtimeUrl: string) => Effect.Effect<LaunchPtyProcessInput, HarnessAdapterError>,
) {
  return Effect.gen(function* () {
    const runtimeUrl = process.env.ISAGI_RUNTIME_URL;
    if (!runtimeUrl) {
      return yield* Effect.fail(
        new HarnessAdapterError(
          'runtime_url_unavailable',
          'Cannot launch an agent before the runtime URL is available.',
        ),
      );
    }
    return yield* build(runtimeUrl);
  });
}
