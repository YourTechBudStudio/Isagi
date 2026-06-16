import { Context, Effect, Layer } from 'effect';

import type { AgentHarness } from '@isagi/contracts';

import { HarnessEventEndpoint } from '../harness-events/endpoint.service.js';
import { HarnessEventTokenRegistry } from '../harness-events/token-registry.js';
import { DataDirectory } from '../persistence/index.js';
import { commandForHarness } from '../pty-processes/service/runtime-namespace.js';
import type { LaunchPtyProcessInput } from '../pty-processes/types.js';
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
    return {
      buildLaunch: (input) => {
        if (input.harness === 'pi') {
          return Effect.gen(function* () {
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
            return yield* buildPiLaunch(input, {
              dataRoot: directory.paths.root,
              eventUrl,
              tokens,
            });
          });
        }
        return Effect.succeed(legacyLaunchEnvelope(input));
      },
    } satisfies HarnessAdapterRegistryService;
  }),
);

function legacyLaunchEnvelope(input: HarnessLaunchContext): LaunchPtyProcessInput {
  const command = commandForHarness(input.harness);
  if (!input.latestHarnessSessionId) return { command, args: [], cwd: input.cwd };
  switch (input.harness) {
    case 'claude':
      return { command, args: ['--resume', input.latestHarnessSessionId], cwd: input.cwd };
    case 'opencode':
      return {
        command,
        args: ['--session', input.latestHarnessSessionId, input.cwd],
        cwd: input.cwd,
      };
    case 'codex':
      return { command, args: ['resume', input.latestHarnessSessionId], cwd: input.cwd };
    case 'pi':
      return { command, args: ['--session', input.latestHarnessSessionId], cwd: input.cwd };
  }
}
