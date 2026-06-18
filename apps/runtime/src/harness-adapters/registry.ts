import { Context, Effect, Layer } from 'effect';

import type { AgentHarness } from '@isagi/contracts';

import { AgentSessionArtifacts } from '../agent-sessions/index.js';
import { DataDirectory } from '../persistence/index.js';
import type { LaunchPtyProcessInput } from '../pty-processes/types.js';
import { prepareHarnessIntegrationArtifacts } from './artifacts.js';
import { buildClaudeLaunch } from './claude.adapter.js';
import { buildCodexLaunch } from './codex.adapter.js';
import { buildOpenCodeLaunch } from './opencode.adapter.js';
import { buildPiLaunch } from './pi.adapter.js';
import { HarnessAdapterError, type HarnessLaunchContext } from './types.js';

export interface HarnessAdapterRegistryService {
  readonly buildLaunch: (
    input: HarnessLaunchContext,
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
        buildPiLaunch(input, {
          extensionPath: artifacts.piExtensionPath,
          artifacts: sessionArtifacts,
        }),
      opencode: (input) =>
        buildOpenCodeLaunch(input, {
          pluginPath: artifacts.opencodePluginPath,
          artifacts: sessionArtifacts,
        }),
      claude: (input) =>
        buildClaudeLaunch(input, {
          settingsPath: artifacts.claudeSettingsPath,
          artifacts: sessionArtifacts,
        }),
      codex: (input) =>
        buildCodexLaunch(input, {
          hookPath: artifacts.codexHookPath,
          artifacts: sessionArtifacts,
        }),
    } satisfies Record<
      AgentHarness,
      (input: HarnessLaunchContext) => Effect.Effect<LaunchPtyProcessInput, HarnessAdapterError>
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
    } satisfies HarnessAdapterRegistryService;
  }),
);
