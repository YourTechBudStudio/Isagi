import { Context, Effect, Layer } from 'effect';

import type { ProcessTokenHolder } from '../access/index.js';
import { CliAccess } from '../cli-access/index.js';
import { launchEnv, UserShell } from '../platform/process/index.js';

const make = Effect.gen(function* () {
  const userShell = yield* UserShell;
  const cliAccess = yield* CliAccess;
  const userEnvironment = launchEnv(userShell.environment.values);
  return LaunchEnvironment.of({
    userEnvironment,
    // The CLI variables are resolved per call: the runtime URL is only known once the server
    // listens, and each process gets its own token, while the user environment was captured when
    // the layer was built.
    forProcess: (holder) =>
      Effect.map(cliAccess.launchEnvironment(userEnvironment.PATH, holder), (cli) => ({
        ...userEnvironment,
        ...cli,
      })),
  });
});

/**
 * The environment Isagi gives every user-facing process it launches, PTYs and SDK workers alike:
 * the sanitized login-shell environment plus CLI access. Callers add their own overrides on top.
 *
 * There is no tokenless launch variant: a process gets `forProcess`, which issues its holder's
 * process token, and the holder's owner releases that token when the process ends.
 */
export class LaunchEnvironment extends Context.Service<
  LaunchEnvironment,
  {
    /** The sanitized login-shell environment, without CLI variables. For readers that launch nothing (config key resolution). */
    readonly userEnvironment: NodeJS.ProcessEnv;
    /** The full environment for one launched process: user environment + CLI access, including its process token. */
    readonly forProcess: (holder: ProcessTokenHolder) => Effect.Effect<NodeJS.ProcessEnv>;
  }
>()('isagi/runtime/pty-processes/LaunchEnvironment') {
  static readonly layerNoDeps = Layer.effect(LaunchEnvironment, make);
  static readonly layer = LaunchEnvironment.layerNoDeps.pipe(Layer.provide(CliAccess.layer));
}
