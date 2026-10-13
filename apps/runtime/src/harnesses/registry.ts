import { Context, Effect, Layer } from 'effect';

import type { AgentHarness } from '@isagi/contracts';

import { DataDirectory } from '../platform/persistence/index.js';
import type { LaunchPtyProcessInput } from '../pty-processes/index.js';
import { prepareHarnessIntegrationArtifacts } from './artifacts.js';
import { harnessDefinition, harnessDefinitions, type SdkHarness } from './definitions.js';
import { AgentSessionArtifacts } from './ledger.js';
import {
  HarnessAdapterError,
  type HarnessHeadlessLaunchContext,
  type HarnessLaunchContext,
  type SdkInstrumentation,
} from './types.js';

const make = Effect.gen(function* () {
  const directory = yield* DataDirectory;
  const sessionArtifacts = yield* AgentSessionArtifacts;
  yield* prepareHarnessIntegrationArtifacts(directory.paths.root);

  const dependencies = { dataRoot: directory.paths.root, artifacts: sessionArtifacts };

  return HarnessAdapterRegistry.of({
    buildLaunch: Effect.fn('HarnessAdapterRegistry.buildLaunch')(function* (input) {
      return yield* harnessDefinition(input.harness).launch.interactive(input, dependencies);
    }),
    buildHeadlessLaunch: Effect.fn('HarnessAdapterRegistry.buildHeadlessLaunch')(function* (input) {
      return yield* harnessDefinition(input.harness).launch.headless(input);
    }),
    supportsSdk: (harness): harness is SdkHarness =>
      harnessDefinition(harness).launch.sdk !== undefined,
    buildSdkInstrumentation: Effect.fn('HarnessAdapterRegistry.buildSdkInstrumentation')(
      function* (input) {
        return yield* harnessDefinitions[input.harness].launch.sdk(
          { agentSessionId: input.agentSessionId, executionId: input.executionId },
          dependencies,
        );
      },
    ),
  });
});

export class HarnessAdapterRegistry extends Context.Service<
  HarnessAdapterRegistry,
  {
    readonly buildLaunch: (
      input: HarnessLaunchContext,
    ) => Effect.Effect<LaunchPtyProcessInput, HarnessAdapterError>;
    readonly buildHeadlessLaunch: (
      input: HarnessHeadlessLaunchContext,
    ) => Effect.Effect<LaunchPtyProcessInput, HarnessAdapterError>;
    /** Whether an SDK worker can drive this harness (it defines `launch.sdk`); narrows to `SdkHarness`. */
    readonly supportsSdk: (harness: AgentHarness) => harness is SdkHarness;
    readonly buildSdkInstrumentation: (input: {
      readonly agentSessionId: number;
      readonly harness: SdkHarness;
      readonly executionId: string;
    }) => Effect.Effect<SdkInstrumentation, HarnessAdapterError>;
  }
>()('isagi/runtime/harnesses/HarnessAdapterRegistry') {
  static readonly layerNoDeps = Layer.effect(HarnessAdapterRegistry, make);
  static readonly layer = HarnessAdapterRegistry.layerNoDeps.pipe(
    Layer.provide(AgentSessionArtifacts.layer),
  );
}
