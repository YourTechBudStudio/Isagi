import { Context, Duration } from 'effect';

/**
 * The commands module's tunables. Production uses the defaults; tests provide other values with
 * `Layer.succeed(CommandSettings, {...})`.
 */
export interface CommandTimings {
  /** How long a stop waits for a command's process to exit on its own before the PTY layer forces it. */
  readonly stopGracefulTimeout: Duration.Duration;
}

export const CommandSettings = Context.Reference<CommandTimings>(
  'isagi/runtime/commands/CommandSettings',
  { defaultValue: () => ({ stopGracefulTimeout: Duration.seconds(2) }) },
);
