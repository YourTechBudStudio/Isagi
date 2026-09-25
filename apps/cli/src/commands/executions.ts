import { Effect } from 'effect';

import { apiEndpoints } from '@isagi/contracts';

import { call } from '../runtime-api.js';
import type { GroupHandlers } from './handlers.js';
import { compact } from './query.js';

const workflows = apiEndpoints.workflows;

export const executionsHandlers = {
  /**
   * One frame's executions. Without `--frame` the frame is the run's root frame, read from the run
   * detail, so descending a run is always "root, then the child frame an execution names".
   */
  'executions list': ({ options }) =>
    Effect.gen(function* () {
      const runId = options.run;
      const frameId = options.frame ?? (yield* call(workflows.getRun, { runId })).rootFrame.frameId;
      const page = yield* call(
        workflows.listFrameExecutions,
        { runId, frameId },
        compact({ nodeId: options.node, cursor: options.cursor, limit: options.limit }),
      );
      return { frameId, items: page.items, nextCursor: page.nextCursor };
    }),
  'executions inspect': ({ positionals, options }) =>
    call(workflows.getExecution, { runId: options.run, executionId: positionals.executionId }),
} satisfies GroupHandlers<'executions'>;

export const attemptsHandlers = {
  'attempts list': ({ options }) =>
    call(
      workflows.listAttempts,
      { runId: options.run },
      compact({ executionId: options.execution, cursor: options.cursor, limit: options.limit }),
    ),
} satisfies GroupHandlers<'attempts'>;

export const operationsHandlers = {
  'operations list': ({ options }) =>
    call(
      workflows.listOperations,
      { runId: options.run },
      compact({ executionId: options.execution, cursor: options.cursor, limit: options.limit }),
    ),
  'operations inspect': ({ positionals, options }) =>
    call(workflows.getOperation, { runId: options.run, operationKey: positionals.operationKey }),
} satisfies GroupHandlers<'operations'>;

export const payloadsHandlers = {
  'payloads read': ({ positionals, options }) =>
    call(workflows.getPayload, { runId: options.run, payloadRef: positionals.payloadRef }),
} satisfies GroupHandlers<'payloads'>;
