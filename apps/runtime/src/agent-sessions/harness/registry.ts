import { Context, Effect, Layer } from 'effect';

import { DataDirectory } from '../../persistence/index.js';
import type { LaunchPtyProcessInput } from '../../pty-processes/types.js';
import { prepareHarnessIntegrationArtifacts } from './artifacts.js';
import { harnessDefinition } from './definitions.js';
import { AgentSessionArtifacts } from './ledger.js';
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
    yield* prepareHarnessIntegrationArtifacts(directory.paths.root);

    return {
      buildLaunch: (input) =>
        harnessDefinition(input.harness).launch.interactive(input, {
          dataRoot: directory.paths.root,
          artifacts: sessionArtifacts,
        }),
      buildHeadlessLaunch: (input) => harnessDefinition(input.harness).launch.headless(input),
    } satisfies HarnessAdapterRegistryService;
  }),
);
