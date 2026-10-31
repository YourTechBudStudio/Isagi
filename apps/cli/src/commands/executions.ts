import { Option } from 'effect';
import { Flag } from 'effect/cli';

import { apiEndpoints } from '@isagi/contracts';

import { call } from '../runtime-api.js';
import { clientCommand, group } from './define.js';
import { cursorFlag, limitFlag, runFlag } from './flags.js';
import { compact } from './query.js';
import { argument, flag, positiveInteger } from './values.js';

const workflows = apiEndpoints.workflows;

export const executionsGroup = group('executions', {
  summary: 'Inspect one execution of a workflow node.',
  examples: [{ command: 'isagi workflows executions show 137 --json' }],
  commands: [
    clientCommand('show', {
      summary:
        'Show one execution: result, event, decision, state after, error, operations and checkpoint.',
      examples: [{ command: 'isagi workflows executions show 137 --json' }],
      config: { executionId: argument(positiveInteger('executionId'), 'The execution.') },
      run: (args) => call(workflows.getExecution, { executionId: args.executionId }),
    }),
  ],
});

export const operationsGroup = group('operations', {
  summary: "Read a run's operations: the prompts it sent and the replies it received.",
  examples: [
    { command: 'isagi workflows operations list --run 42 --json' },
    { command: 'isagi workflows operations show 31 --json' },
  ],
  commands: [
    /** The dialogue: prompts and replies in the order they happened, optionally one session's. */
    clientCommand('list', {
      summary: "List a run's operations in order: the prompts sent and the replies received.",
      examples: [
        { command: 'isagi workflows operations list --run 42 --json' },
        {
          command: 'isagi workflows operations list --run 42 --session 9 --json',
          description: 'One agent conversation',
        },
      ],
      config: {
        run: runFlag,
        session: flag(
          'session',
          positiveInteger('agentSessionId'),
          'Only operations of this agent session: one conversation.',
        ).pipe(Flag.optional),
        execution: flag(
          'execution',
          positiveInteger('executionId'),
          'Only operations of this execution.',
        ).pipe(Flag.optional),
        cursor: cursorFlag,
        limit: limitFlag,
      },
      run: (args) =>
        call(
          workflows.listOperations,
          { runId: args.run },
          compact({
            agentSessionId: Option.getOrUndefined(args.session),
            executionId: Option.getOrUndefined(args.execution),
            cursor: Option.getOrUndefined(args.cursor),
            limit: Option.getOrUndefined(args.limit),
          }),
        ),
    }),
    clientCommand('show', {
      summary: 'Show one operation in full: request, reply, result, usage and timing.',
      examples: [{ command: 'isagi workflows operations show 31 --json' }],
      config: { operationId: argument(positiveInteger('operationId'), 'The operation.') },
      run: (args) => call(workflows.getOperation, { operationId: args.operationId }),
    }),
  ],
});
