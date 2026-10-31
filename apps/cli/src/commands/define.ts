/**
 * How the `isagi` command tree is built: client leaves, groups, and the runner every leaf calls.
 *
 * One tree serves both real invocations and `checkCommandLine`: a leaf's handler does its own
 * pre-request checks (value kinds through `effect/cli`, `requires` pairs here), then hands its work
 * to the `CommandRunner` in context. Production provides a runner that targets a runtime and runs
 * the work; `checkCommandLine` provides one that runs nothing.
 */
import { Context, Effect, Option } from 'effect';
import { Command, Flag } from 'effect/cli';

import type { RuntimeClient } from '@isagi/runtime-client';

import type { CliContext } from '../context.js';
import { CliFailure } from '../errors.js';
import type { ServeFlags } from '../serve/settings.js';

/** What a leaf asks of its invocation. Production runs it; `checkCommandLine` runs nothing. */
export class CommandRunner extends Context.Service<
  CommandRunner,
  {
    readonly client: (command: ClientInvocation) => Effect.Effect<void, CliFailure>;
    readonly serve: (flags: ServeFlags) => Effect.Effect<void, CliFailure>;
  }
>()('isagi/cli/CommandRunner') {}

export interface ClientInvocation {
  /** `raw` writes its own bytes to stdout and succeeds with nothing; `json` prints its value. */
  readonly stdout: 'json' | 'raw';
  readonly runtimeUrl: Option.Option<string>;
  readonly run: Effect.Effect<unknown, CliFailure, RuntimeClient | CliContext>;
}

/** At least one example: every node's help shows how to use it. */
export type Examples = readonly [Command.Command.Example, ...Command.Command.Example[]];

/** One node's words below its parent, and whether its stdout is a JSON document or raw bytes. */
export interface CatalogEntry {
  readonly path: ReadonlyArray<string>;
  readonly stdout: 'json' | 'raw';
}

/**
 * A built command with the catalog of itself and everything under it. Name and input vary per node
 * (`Name` is invariant), so they are erased; failures and requirements stay typed for the root.
 */
export interface CommandNode {
  // oxlint-disable-next-line no-explicit-any
  readonly command: Command.Command<any, any, any, CliFailure, CommandRunner>;
  readonly catalog: ReadonlyArray<CatalogEntry>;
}

export const jsonNote = 'Add --json to print exactly one JSON document.';
const rawNote = 'Writes raw bytes to stdout; failures go to stderr.';

const runtimeUrlFlag = Flag.String('runtime-url').pipe(
  Flag.withMetavar('url'),
  Flag.withDescription('The runtime to call; overrides ISAGI_RUNTIME_URL.'),
  Flag.optional,
);

/**
 * A client leaf: a command that calls the runtime. It gains `--runtime-url`, the `--json` note in
 * its description, and its examples; its handler checks `requires`, then hands `run` to the runner.
 * Every failure of a raw command, including the pre-runner ones, is marked raw so it never reaches
 * the byte stream.
 */
export function clientCommand<const Config extends Command.Command.Config>(
  verb: string,
  spec: {
    readonly summary: string;
    readonly examples: Examples;
    readonly config: Config;
    readonly stdout?: 'raw';
    /** `[a, b]`: giving `a` requires `b` (config keys of optional flags). */
    readonly requires?: ReadonlyArray<readonly [keyof Config & string, keyof Config & string]>;
    readonly run: (
      args: Command.Command.Config.Infer<Config>,
    ) => Effect.Effect<unknown, CliFailure, RuntimeClient | CliContext>;
  },
): CommandNode {
  const stdout = spec.stdout ?? 'json';
  const command = Command.make(
    verb,
    { ...spec.config, runtimeUrl: runtimeUrlFlag },
    (args): Effect.Effect<void, CliFailure, CommandRunner> => {
      const values = args as unknown as Readonly<Record<string, unknown>>;
      const program = Effect.gen(function* () {
        for (const [given, partner] of spec.requires ?? []) {
          if (isGiven(values[given]) && !isGiven(values[partner])) {
            const flag = `--${kebab(given)}`;
            const requires = `--${kebab(partner)}`;
            return yield* CliFailure.of('cli_usage_invalid', `${flag} requires ${requires}.`, {
              context: { flag, requires },
              recovery: `Add ${requires} too, or drop ${flag}.`,
            });
          }
        }
        yield* CommandRunner.use((runner) =>
          runner.client({
            stdout,
            runtimeUrl: values.runtimeUrl as Option.Option<string>,
            run: spec.run(args as unknown as Command.Command.Config.Infer<Config>),
          }),
        );
      });
      return stdout === 'raw'
        ? program.pipe(Effect.mapError((failure) => failure.inRawCommand()))
        : program;
    },
  ).pipe(
    Command.withDescription(
      [spec.summary, jsonNote, ...(stdout === 'raw' ? [rawNote] : [])].join(' '),
    ),
    Command.withShortDescription(spec.summary),
    Command.withExamples(spec.examples),
  );
  return { command, catalog: [{ path: [verb], stdout }] };
}

/** A group: leaves and nested groups under one word. Without a command after it, a usage error. */
export function group(
  name: string,
  spec: {
    readonly summary: string;
    readonly examples: Examples;
    readonly commands: readonly [CommandNode, ...CommandNode[]];
  },
): CommandNode {
  const [first, ...rest] = spec.commands;
  const command = Command.make(name).pipe(
    Command.withDescription(spec.summary),
    Command.withExamples(spec.examples),
    Command.withSubcommands([first.command, ...rest.map((node) => node.command)]),
  );
  return {
    command,
    catalog: [
      { path: [name], stdout: 'json' },
      ...spec.commands.flatMap((node) =>
        node.catalog.map((entry) => ({ path: [name, ...entry.path], stdout: entry.stdout })),
      ),
    ],
  };
}

function isGiven(value: unknown): boolean {
  return Option.isOption(value) ? Option.isSome(value) : value !== undefined;
}

function kebab(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}
