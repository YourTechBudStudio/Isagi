import { apiEndpoints } from '@isagi/contracts';

import { call } from '../runtime-api.js';
import type { GroupHandlers } from './handlers.js';
import { compact } from './query.js';

const workflows = apiEndpoints.workflows;

export const executionsHandlers = {
  'executions show': ({ positionals }) =>
    call(workflows.getExecution, { executionId: positionals.executionId }),
} satisfies GroupHandlers<'executions'>;

export const operationsHandlers = {
  /** The dialogue: prompts and replies in the order they happened, optionally one session's. */
  'operations list': ({ options }) =>
    call(
      workflows.listOperations,
      { runId: options.run },
      compact({
        agentSessionId: options.session,
        executionId: options.execution,
        cursor: options.cursor,
        limit: options.limit,
      }),
    ),
  'operations show': ({ positionals }) =>
    call(workflows.getOperation, { operationId: positionals.operationId }),
} satisfies GroupHandlers<'operations'>;
