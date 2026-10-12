import { Context, Effect, Layer } from 'effect';

import { DataDirectory } from '../platform/persistence/index.js';
import type { LaunchPtyProcessInput } from '../pty-processes/index.js';
import { prepareHarnessIntegrationArtifacts } from './artifacts.js';
import { harnessDefinition } from './definitions.js';
import { AgentSessionArtifacts } from './ledger.js';
import {
  HarnessAdapterError,
  type HarnessHeadlessLaunchContext,
  type HarnessLaunchContext,
} from './types.js';

const make = Effect.gen(function* () {
  const directory = yield* DataDirectory;
  const sessionArtifacts = yield* AgentSessionArtifacts;
  yield* prepareHarnessIntegrationArtifacts(directory.paths.root);

  return HarnessAdapterRegistry.of({
    buildLaunch: Effect.fn('HarnessAdapterRegistry.buildLaunch')(function* (input) {
      return yield* harnessDefinition(input.harness).launch.interactive(input, {
        dataRoot: directory.paths.root,
        artifacts: sessionArtifacts,
      });
    }),
    buildHeadlessLaunch: Effect.fn('HarnessAdapterRegistry.buildHeadlessLaunch')(function* (input) {
      return yield* harnessDefinition(input.harness).launch.headless(input);
    }),
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
  }
>()('isagi/runtime/harnesses/HarnessAdapterRegistry') {
  static readonly layerNoDeps = Layer.effect(HarnessAdapterRegistry, make);
  static readonly layer = HarnessAdapterRegistry.layerNoDeps.pipe(
    Layer.provide(AgentSessionArtifacts.layer),
  );
}
