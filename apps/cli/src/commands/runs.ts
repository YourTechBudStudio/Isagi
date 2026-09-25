import { apiEndpoints } from '@isagi/contracts';

import { call } from '../runtime-api.js';
import type { GroupHandlers } from './handlers.js';
import { compact } from './query.js';

const workflows = apiEndpoints.workflows;

export const runsHandlers = {
  'runs list': ({ options }) =>
    call(
      workflows.listRuns,
      compact({
        workflowKey: options.workflow,
        status: options.status,
        cursor: options.cursor,
        limit: options.limit,
      }),
    ),
  'runs inspect': ({ positionals }) => call(workflows.getRun, { runId: positionals.runId }),
  'runs versions': ({ positionals, options }) =>
    call(
      workflows.listVersions,
      { runId: positionals.runId },
      compact({ cursor: options.cursor, limit: options.limit }),
    ),
  'runs structure': ({ positionals, options }) =>
    call(
      workflows.getStructure,
      { runId: positionals.runId },
      compact({ artifactHash: options['artifact-hash'] }),
    ),
  'runs events': ({ positionals, options }) =>
    call(
      workflows.listEvents,
      { runId: positionals.runId },
      compact({ cursor: options.cursor, limit: options.limit }),
    ),
  'runs pause': ({ positionals }) => call(workflows.pause, { runId: positionals.runId }),
  'runs resume': ({ positionals }) => call(workflows.resume, { runId: positionals.runId }),
  'runs retry': ({ positionals }) => call(workflows.retry, { runId: positionals.runId }),
  'runs cancel': ({ positionals }) => call(workflows.cancel, { runId: positionals.runId }),
} satisfies GroupHandlers<'runs'>;
