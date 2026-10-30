import { Console, Effect, FileSystem, Layer, Path, Stdio, Terminal } from 'effect';
import { CliConfig, CliOutput, GlobalFlag, type HelpDoc } from 'effect/cli';
import { ChildProcessSpawner } from 'effect/process';

/** What one invocation printed through `effect/cli`, and the help document it printed last. */
export interface CliCapture {
  readonly printed: string[];
  helpDoc: HelpDoc.HelpDoc | undefined;
}

export function newCliCapture(): CliCapture {
  return { printed: [], helpDoc: undefined };
}

/**
 * The environment `effect/cli` runs in, built from core constructors only.
 *
 * Every line it prints (help, version, and errors, which `renderErrors: false` keeps empty anyway)
 * lands in `capture`, so `runCli` alone decides what reaches stdout and stderr. The help formatter
 * records the `HelpDoc` it formats, which is how a usage error lists the valid commands and flags.
 * Built-ins are only `--help` and `--version`.
 *
 * The CLI passes its arguments explicitly and uses no file flags, prompts or wizard, so the
 * platform services below are never reached; each dies if one is, which surfaces as a defect. The
 * `ChildProcessSpawner` tag is imported only to satisfy `Command.Environment`; nothing spawns.
 */
export function cliEnvironment(capture: CliCapture) {
  const record = (...args: ReadonlyArray<unknown>) => {
    capture.printed.push(args.map(String).join(' '));
  };
  const base = CliOutput.defaultFormatter({ colors: false });
  const unreachable = (what: string) =>
    Effect.die(new Error(`The isagi CLI does not use ${what}.`));

  return Layer.mergeAll(
    Layer.succeed(Console.Console, { ...globalThis.console, log: record, error: record }),
    CliOutput.layer({
      ...base,
      formatHelpDoc: (doc) => {
        capture.helpDoc = doc;
        return base.formatHelpDoc(doc);
      },
    }),
    CliConfig.layer({ builtIns: [GlobalFlag.Help, GlobalFlag.Version] }),
    FileSystem.layerNoop({}),
    Path.layer,
    Stdio.layerTest({}),
    Layer.succeed(
      Terminal.Terminal,
      Terminal.make({
        columns: Effect.succeed(80),
        rows: Effect.succeed(24),
        readInput: unreachable('terminal input'),
        readLine: unreachable('terminal input'),
        display: () => Effect.void,
      }),
    ),
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => unreachable('child processes')),
    ),
  );
}
