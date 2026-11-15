import { Effect, Layer } from 'effect';

import { UserShell, type UserShellCommandResult } from './user-shell.js';

export interface TestUserShellOptions {
  /** The probed login-shell environment. Default a fixed developer environment (`/home/developer`, `/usr/bin:/bin`). */
  readonly environment?: NodeJS.ProcessEnv;
  /** Answers `UserShell.run`. Default dies, so a test that unexpectedly runs a user-shell command fails loudly. */
  readonly run?: UserShell['Service']['run'];
}

/**
 * A {@link UserShell} that never spawns the user's login shell. Tests replace the live layer with this: the live one
 * runs `$SHELL -lic` with the developer's own rc files, which is slow and makes results depend on the machine.
 */
export function testUserShell(options: TestUserShellOptions = {}): UserShell['Service'] {
  return UserShell.of({
    environment: {
      _tag: 'Available',
      values: options.environment ?? {
        HOME: '/home/developer',
        PATH: '/usr/bin:/bin',
        SHELL: '/bin/zsh',
      },
    },
    run: options.run ?? ((input) => Effect.die(`unexpected user-shell command: ${input.command}`)),
  });
}

/** {@link testUserShell} as a layer. */
export function testUserShellLayer(options: TestUserShellOptions = {}) {
  return Layer.succeed(UserShell, testUserShell(options));
}

/** A `run` answer for a shell where no command is installed: exit 127, as a login shell reports it. */
export const commandNotFound: UserShell['Service']['run'] = (input) =>
  Effect.succeed<UserShellCommandResult>({
    exitCode: 127,
    signal: null,
    stdout: '',
    stderr: `${input.command}: command not found`,
    timedOut: false,
    outputTruncated: false,
  });
