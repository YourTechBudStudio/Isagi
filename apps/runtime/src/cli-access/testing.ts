import { Effect, Layer } from 'effect';

import { CliAccess } from './service.js';

/** For tests that launch PTYs: publishes nothing and adds nothing to a launch's environment. */
export const noCliAccess: CliAccess['Service'] = {
  publishRuntimeUrl: () => Effect.void,
  launchEnvironment: () => Effect.succeed({}),
};

export const CliAccessNone: Layer.Layer<CliAccess> = Layer.succeed(CliAccess, noCliAccess);
