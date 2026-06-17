import { Context, Effect, Layer } from 'effect';

import { HarnessEventEndpoint } from '../harness-events/endpoint.service.js';
import { HarnessEventTokenRegistry } from '../harness-events/token-registry.js';
import { DataDirectory } from '../persistence/index.js';
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
        console.warn('[runtime] Harness launch rejected: unsupported harness adapter', {
          agentSessionId: input.agentSessionId,
          harness: input.harness,
          cwd: input.cwd,
          latestHarnessSessionId: input.latestHarnessSessionId,
        });
        return Effect.fail(
          new HarnessAdapterError(
            'unsupported_harness',
            `Harness ${input.harness} is not wired for Isagi restoration yet.`,
          ),
        );
      },
    } satisfies HarnessAdapterRegistryService;
  }),
);
