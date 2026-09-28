import type { Effect } from 'effect';

import type { CliIo } from '../context.js';
import type { CliFailure } from '../errors.js';
import type { RuntimeApiService } from '../runtime-api.js';
import type { CommandArguments, CommandId } from './table.js';

/**
 * One command's behavior. A `json` command succeeds with the value it prints; a `raw` command writes
 * its own bytes and succeeds with nothing.
 */
export type CommandHandler<Id extends CommandId> = (
  args: CommandArguments<Id>,
) => Effect.Effect<unknown, CliFailure, RuntimeApiService | CliIo>;

/** Exactly the handlers of one group: a missing, extra or misspelled command fails to typecheck. */
export type GroupHandlers<Group extends string> = {
  readonly [Id in Extract<CommandId, `${Group} ${string}`>]: CommandHandler<Id>;
};

/** Exactly one handler for every table entry. */
export type CommandHandlers = { readonly [Id in CommandId]: CommandHandler<Id> };
