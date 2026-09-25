/**
 * Every command's handler, keyed by the command id the table declares.
 *
 * The `satisfies` below is the exhaustiveness rule: a table entry without a handler, or a handler
 * without a table entry, fails `typecheck` rather than surfacing at runtime. Each group file checks
 * its own keys the same way, so a misplaced handler fails where it is written.
 */
import { checkpointsHandlers } from './checkpoints.js';
import { evidenceHandlers } from './evidence.js';
import {
  attemptsHandlers,
  executionsHandlers,
  operationsHandlers,
  payloadsHandlers,
} from './executions.js';
import type { CommandHandler, CommandHandlers } from './handlers.js';
import { runsHandlers } from './runs.js';
import type { CommandId } from './table.js';
import { workflowsHandlers } from './workflows.js';

export const commandHandlers = {
  ...workflowsHandlers,
  ...runsHandlers,
  ...executionsHandlers,
  ...attemptsHandlers,
  ...operationsHandlers,
  ...payloadsHandlers,
  ...evidenceHandlers,
  ...checkpointsHandlers,
} satisfies CommandHandlers;

export function handlerFor(id: CommandId): CommandHandler<CommandId> {
  return commandHandlers[id] as CommandHandler<CommandId>;
}
