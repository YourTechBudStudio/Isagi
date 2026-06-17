import { Context, Effect, Layer } from 'effect';

import type { AgentHarness } from '@isagi/contracts';

import { HarnessEventEndpoint } from '../harness-events/endpoint.service.js';
import { HarnessEventTokenRegistry } from '../harness-events/token-registry.js';
import { DataDirectory } from '../persistence/index.js';
import type { LaunchPtyProcessInput } from '../pty-processes/types.js';
import { prepareHarnessIntegrationArtifacts } from './artifacts.js';
import { buildClaudeLaunch } from './claude-adapter.js';
import { buildCodexLaunch } from './codex-adapter.js';
import { buildOpenCodeLaunch } from './opencode-adapter.js';
import { buildPiLaunch } from './pi-adapter.js';
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
    const endpoint = yield* HarnessEventEndpoint;
    const tokens = yield* HarnessEventTokenRegistry;
    const artifacts = yield* prepareHarnessIntegrationArtifacts(directory.paths.root);

    const adapterFactories = {
      pi: (input, eventUrl) =>
        buildPiLaunch(input, {
          extensionPath: artifacts.piExtensionPath,
          eventUrl,
          tokens,
        }),
      opencode: (input, eventUrl) =>
        buildOpenCodeLaunch(input, {
          pluginPath: artifacts.opencodePluginPath,
          eventUrl,
          tokens,
        }),
      claude: (input, eventUrl) =>
        buildClaudeLaunch(input, {
          settingsPath: artifacts.claudeSettingsPath,
          eventUrl,
          tokens,
        }),
      codex: (input, eventUrl) =>
        buildCodexLaunch(input, {
          hookPath: artifacts.codexHookPath,
          eventUrl,
          tokens,
        }),
    } satisfies Record<
      AgentHarness,
      (
        input: HarnessLaunchContext,
        eventUrl: string,
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
          const eventUrl = yield* endpoint.eventUrl.pipe(
            Effect.mapError(
              (cause) =>
                new HarnessAdapterError(
                  'event_endpoint_unavailable',
                  'Harness event endpoint has not been initialized.',
                  cause,
                ),
            ),
          );
          return yield* build(input, eventUrl);
        }),
    } satisfies HarnessAdapterRegistryService;
  }),
);
