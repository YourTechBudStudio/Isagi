import { Cause, Effect, Exit, Layer, Option } from 'effect';

import { handlerFor } from './commands/index.js';
import { parseCommandLine } from './commands/table.js';
import { CliContext, type CliIo } from './context.js';
import { CliFailure } from './errors.js';
import { CommandResult, exitCodeFor, renderFailure, renderResult, renderText } from './output.js';
import { runtimeApiLayer, type RuntimeApiService } from './runtime-api.js';
import { resolveRuntimeUrl } from './target.js';

export interface RunCliOptions {
  /** The runtime API for a resolved URL; tests pass a fake keyed by endpoint id. */
  readonly runtimeApi?: (runtimeUrl: string) => Layer.Layer<RuntimeApiService>;
}

/**
 * One `isagi` invocation: parse, target, run, render. Returns the exit status.
 *
 * Nothing here exits the process or reads process globals, so tests run the whole CLI in process.
 * An unexpected defect is rethrown rather than dressed up as an error document: it is a bug, and
 * the process boundary reports it as one.
 */
export async function runCli(
  argv: readonly string[],
  io: CliIo,
  options: RunCliOptions = {},
): Promise<number> {
  const parsed = parseCommandLine(argv);
  if (parsed.kind === 'help') {
    await renderText(io, parsed.text);
    return 0;
  }
  if (parsed.kind === 'usage_error') {
    const failure = CliFailure.of('cli_usage_invalid', parsed.message);
    await renderFailure(io, failure.document, { json: parsed.global.json, raw: false });
    return 2;
  }

  const mode = { json: parsed.global.json, raw: parsed.spec.stdout === 'raw' };
  const target = resolveRuntimeUrl({ flag: parsed.global.runtimeUrl, env: io.env });
  if (!target.ok) {
    await renderFailure(io, target.failure.document, mode);
    return exitCodeFor(target.failure.document);
  }

  const program = handlerFor(parsed.id)(parsed.arguments).pipe(
    Effect.provide(
      Layer.merge(
        (options.runtimeApi ?? runtimeApiLayer)(target.url),
        Layer.succeed(CliContext, io),
      ),
    ),
  );
  const exit = await Effect.runPromiseExit(program);

  if (Exit.isSuccess(exit)) {
    const result = exit.value;
    if (result instanceof CommandResult) {
      if (!mode.json && result.text !== undefined) await renderText(io, result.text);
      else await renderResult(io, result.value, mode.json);
      return result.exitCode;
    }
    if (!mode.raw) await renderResult(io, result, mode.json);
    return 0;
  }
  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure)) {
    await renderFailure(io, failure.value.document, mode);
    return exitCodeFor(failure.value.document);
  }
  throw Cause.squash(exit.cause);
}
