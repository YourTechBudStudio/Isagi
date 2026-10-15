import { Context, Effect, Layer } from 'effect';

import { CliAccess } from '../cli-access/index.js';
import { launchEnv, UserShell } from '../platform/process/index.js';

const make = Effect.gen(function* () {
  const userShell = yield* UserShell;
  const cliAccess = yield* CliAccess;
  const userProcessEnvironment = launchEnv(userShell.environment.values);
  return LaunchEnvironment.of({
    // The CLI variables are resolved per call: the runtime URL is only known once the server
    // listens, while the user environment was captured when the layer was built.
    base: Effect.map(cliAccess.launchEnvironment(userProcessEnvironment.PATH), (cli) => ({
      ...userProcessEnvironment,
      ...cli,
    })),
  });
});

/**
 * The environment Isagi gives every user-facing process it launches, PTYs and SDK workers alike:
 * the sanitized login-shell environment plus CLI access. Callers add their own overrides on top.
 */
export class LaunchEnvironment extends Context.Service<
  LaunchEnvironment,
  { readonly base: Effect.Effect<NodeJS.ProcessEnv> }
>()('isagi/runtime/pty-processes/LaunchEnvironment') {
  static readonly layerNoDeps = Layer.effect(LaunchEnvironment, make);
  static readonly layer = LaunchEnvironment.layerNoDeps.pipe(Layer.provide(CliAccess.layer));
}
