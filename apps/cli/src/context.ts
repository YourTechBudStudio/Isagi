import { Context } from 'effect';

/**
 * The process an invocation runs in, passed in rather than read from globals so tests can run the
 * whole CLI in process.
 */
export interface CliIo {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export class CliContext extends Context.Service<CliContext, CliIo>()('isagi/cli/CliContext') {}
