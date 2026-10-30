import { Cause, Effect, Exit, Layer, Option } from 'effect';
import { CliError, Command } from 'effect/cli';

import { RuntimeClient, RuntimeHttpClient } from '@isagi/runtime-client';

import packageJson from '../package.json' with { type: 'json' };
import { cliEnvironment, newCliCapture } from './cli-environment.js';
import { CommandRunner, type ClientInvocation } from './commands/define.js';
import { isagi, isRawCommand } from './commands/tree.js';
import { CliContext, type CliIo } from './context.js';
import { CliFailure } from './errors.js';
import { exitCodeFor, renderFailure, renderResult, renderText } from './output.js';
import type { RuntimeEntry } from './serve/launch.js';
import { serveRuntimeCommand } from './serve/run.js';
import { resolveRuntimeUrl } from './target.js';
import { usageFailure } from './usage.js';

/** The CLI's version, kept equal to the app's by `pnpm versions:sync`. */
export const cliVersion: string = packageJson.version;

export interface RunCliOptions {
  /** The runtime client for a resolved URL; tests pass a fake keyed by endpoint id. */
  readonly runtimeClient?: (runtimeUrl: string) => Layer.Layer<RuntimeClient>;
  /** Where `serve` finds the runtime. `bin.ts` passes the sibling `index.js`; tests pass a fake. */
  readonly runtimeEntry?: RuntimeEntry;
}

/** The runtime client over the platform `fetch`. */
const httpRuntimeClient = (runtimeUrl: string): Layer.Layer<RuntimeClient> =>
  RuntimeClient.layer(runtimeUrl).pipe(Layer.provide(RuntimeHttpClient));

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
  const { json, rest } = splitJsonFlag(argv);
  const result = await invoke(rest, productionRunner(io, json, options));
  if (result.kind === 'done') {
    if (result.printed !== '') await renderText(io, result.printed);
    return 0;
  }
  await renderFailure(io, result.failure.document, { json, raw: result.failure.raw });
  return exitCodeFor(result.failure.document);
}

/**
 * `--json` is read from the raw command line, never declared to `effect/cli`: every bare `--json`
 * before `--` is removed, so a refused line still knows its output mode and `--json` cannot
 * swallow a following `1` or `yes` the way an `effect/cli` boolean flag would. Any other spelling
 * (`--json=true`) stays and is refused as an unknown flag.
 */
export function splitJsonFlag(argv: readonly string[]): {
  readonly json: boolean;
  readonly rest: readonly string[];
} {
  const end = argv.indexOf('--');
  const head = end < 0 ? argv : argv.slice(0, end);
  const tail = end < 0 ? [] : argv.slice(end);
  const rest = head.filter((token) => token !== '--json');
  return { json: rest.length !== head.length, rest: [...rest, ...tail] };
}

export type InvokeResult =
  | { readonly kind: 'done'; readonly printed: string }
  | { readonly kind: 'failure'; readonly failure: CliFailure };

/**
 * Runs the command tree once with `runner`, capturing everything `effect/cli` prints. A refused
 * command line becomes a usage failure and its help is dropped, so stdout never holds help and an
 * error document together. Shared by `runCli` and `checkCommandLine`.
 */
export async function invoke(
  args: readonly string[],
  runner: CommandRunner['Service'],
): Promise<InvokeResult> {
  const capture = newCliCapture();
  // `Effect.runPromiseExit`, not a `runMain`: `runMain` ends with `process.exit`, which can cut off
  // stdout still being streamed (checkpoint file bytes). The process boundary sets the exit code.
  const exit = await Effect.runPromiseExit(
    Command.runWith(isagi, { version: cliVersion, renderErrors: false })(args).pipe(
      Effect.provideService(CommandRunner, runner),
      Effect.provide(cliEnvironment(capture)),
    ),
  );
  if (Exit.isSuccess(exit)) return { kind: 'done', printed: capture.printed.join('\n') };

  const error = Cause.findErrorOption(exit.cause);
  if (Option.isSome(error)) {
    const failure = error.value;
    if (failure instanceof CliFailure) return { kind: 'failure', failure };
    if (CliError.isCliError(failure)) {
      const usage = usageFailure(failure, capture.helpDoc);
      const raw = failure._tag === 'ShowHelp' && isRawCommand(failure.commandPath);
      return { kind: 'failure', failure: raw ? usage.inRawCommand() : usage };
    }
  }
  throw Cause.squash(exit.cause);
}

/** The runner real invocations use: target a runtime and run the command, or start `serve`. */
function productionRunner(
  io: CliIo,
  json: boolean,
  options: RunCliOptions,
): CommandRunner['Service'] {
  return {
    client: (invocation) => {
      const program = runClient(io, json, options, invocation);
      return invocation.stdout === 'raw'
        ? program.pipe(Effect.mapError((failure) => failure.inRawCommand()))
        : program;
    },
    serve: serveRuntimeCommand(io, options.runtimeEntry),
  };
}

function runClient(
  io: CliIo,
  json: boolean,
  options: RunCliOptions,
  invocation: ClientInvocation,
): Effect.Effect<void, CliFailure> {
  return Effect.gen(function* () {
    const target = resolveRuntimeUrl({
      flag: Option.getOrUndefined(invocation.runtimeUrl),
      env: io.env,
    });
    if (!target.ok) return yield* target.failure;
    const value = yield* invocation.run.pipe(
      Effect.provide(
        Layer.merge(
          (options.runtimeClient ?? httpRuntimeClient)(target.url.value),
          Layer.succeed(CliContext, io),
        ),
      ),
      Effect.mapError((failure) => failure.withContext({ runtimeUrl: target.url })),
    );
    if (invocation.stdout !== 'raw') yield* Effect.promise(() => renderResult(io, value, json));
  });
}
