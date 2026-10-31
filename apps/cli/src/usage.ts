import type { CliError, HelpDoc } from 'effect/cli';

import { CliFailure } from './errors.js';

/** Appended at the root, so an old root spelling (`isagi runs list`) points at the namespace. */
const rootPointer = 'Client commands live under `isagi workflows`.';

/**
 * A command line `effect/cli` refused, as one `cli_usage_invalid` document.
 *
 * `commandPath` already begins with `isagi` and names the deepest command the parser reached, so
 * it is joined as is. The valid commands and flags come from that command's `HelpDoc`, the one
 * `effect/cli` built for the help it printed (and the CLI dropped).
 */
export function usageFailure(
  error: CliError.CliError,
  help: HelpDoc.HelpDoc | undefined,
): CliFailure {
  const commandPath = error._tag === 'ShowHelp' ? error.commandPath : ['isagi'];
  const command = commandPath.join(' ');
  const atRoot = commandPath.length === 1;
  const groupNoun = atRoot ? '' : `${commandPath.at(-1)} `;
  const fail = (message: string, context: Record<string, unknown>, recovery: string) =>
    CliFailure.of('cli_usage_invalid', message, { context: { command, ...context }, recovery });

  const validCommands = help?.subcommands?.flatMap((group) => group.commands.map((c) => c.name));
  const validFlags =
    help === undefined
      ? undefined
      : [...help.flags, ...(help.globalFlags ?? [])]
          .map((flag) => `--${flag.name}`)
          .concat('--json');
  const listing = (key: 'validCommands' | 'validFlags', names: readonly string[] | undefined) =>
    names === undefined ? {} : { [key]: names };

  const cause = error._tag === 'ShowHelp' ? error.errors[0] : error;
  if (cause === undefined) {
    const commandsHelp = `\`${command} --help\` lists them with examples.`;
    return fail(
      `Missing a command after "${command}".`,
      listing('validCommands', validCommands),
      `Add one of them; ${commandsHelp}${atRoot ? ` ${rootPointer}` : ''}`,
    );
  }

  const seeHelp = `\`${command} --help\``;
  switch (cause._tag) {
    case 'UnknownSubcommand': {
      const suggestion = cause.suggestions[0];
      return fail(
        `Unknown command "${cause.subcommand}" for "${command}".`,
        {
          unknown: cause.subcommand,
          suggestions: cause.suggestions,
          ...listing('validCommands', validCommands),
        },
        [
          ...(suggestion === undefined ? [] : [`Did you mean \`${command} ${suggestion}\`?`]),
          `${seeHelp} lists every ${groupNoun}command with examples.`,
          ...(atRoot ? [rootPointer] : []),
        ].join(' '),
      );
    }
    case 'UnrecognizedOption': {
      const suggestion = cause.suggestions[0];
      return fail(
        `Unknown flag "${cause.option}" for "${command}".`,
        {
          unknown: cause.option,
          suggestions: cause.suggestions,
          ...listing('validFlags', validFlags),
        },
        [
          ...(suggestion === undefined ? [] : [`Did you mean \`${suggestion}\`?`]),
          `${seeHelp} lists its flags with examples.`,
        ].join(' '),
      );
    }
    case 'InvalidValue':
      // `effect/cli` reports a flag given without its value with the bare flag name and its
      // metavar as `expected`; the CLI's own value kinds always name `--flag` or `<argument>`.
      if (cause.kind === 'flag' && cause.value === '' && !cause.option.startsWith('-')) {
        const flag = flagName(cause.option);
        return fail(
          `${flag} needs a value.`,
          { flag },
          `Give ${flag} a value; ${seeHelp} shows an example.`,
        );
      }
      return fail(
        `${cause.option} ${cause.expected}, got "${cause.value}".`,
        { [cause.kind]: cause.option, value: cause.value, expected: cause.expected },
        `Fix the value; ${seeHelp} shows the accepted values.`,
      );
    case 'MissingOption':
      return fail(
        `${flagName(cause.option)} is required.`,
        { flag: flagName(cause.option) },
        `Add it; ${seeHelp} shows an example.`,
      );
    case 'MissingArgument':
      return fail(
        `"${command}" needs <${cause.argument}>.`,
        { argument: `<${cause.argument}>` },
        `Add it; ${seeHelp} shows an example.`,
      );
    case 'UnexpectedArgument':
      return fail(
        `Unexpected argument "${cause.arguments[0]}" for "${command}".`,
        { unexpected: cause.arguments },
        `Remove it; ${seeHelp} shows the command's usage.`,
      );
    default:
      return fail(cause.message, {}, `${seeHelp} shows the command's usage.`);
  }
}

function flagName(option: string): string {
  return option.startsWith('-') ? option : `--${option}`;
}
