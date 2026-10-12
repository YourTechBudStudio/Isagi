import { Effect } from 'effect';

import { apiEndpoints } from '@isagi/contracts';

import { call } from '../runtime-api.js';
import type { GroupHandlers } from './handlers.js';
import { resolveOrigin } from './origin.js';
import type { CommandArguments } from './table.js';

export const workflowsHandlers = {
  /** The workflows launchable from the origin worktree, with the origin that was used. */
  'workflows list': Effect.fn('cli.workflows.list')(function* ({
    options,
  }: CommandArguments<'workflows list'>) {
    const origin = yield* resolveOrigin({ worktree: options.worktree, surface: options.surface });
    const { workflows } = yield* call(apiEndpoints.workflows.descriptors, { origin });
    return { origin, workflows };
  }),
} satisfies GroupHandlers<'workflows'>;
