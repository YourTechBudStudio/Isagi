import { Effect, Option } from 'effect';

import { apiEndpoints } from '@isagi/contracts';

import { call } from '../runtime-api.js';
import { checkpointsGroup } from './checkpoints.js';
import { clientCommand, group } from './define.js';
import { executionsGroup, operationsGroup } from './executions.js';
import { originSurfaceFlag, originWorktreeFlag } from './flags.js';
import { resolveOrigin } from './origin.js';
import { runsGroup } from './runs.js';

const list = clientCommand('list', {
  summary: 'List the workflows that can be launched from an origin worktree.',
  examples: [
    { command: 'isagi workflows list --json' },
    {
      command: 'isagi workflows list --worktree 3 --surface 9 --json',
      description: 'From an explicit origin instead of the current directory',
    },
  ],
  config: { worktree: originWorktreeFlag, surface: originSurfaceFlag },
  requires: [['surface', 'worktree']],
  /** The workflows launchable from the origin worktree, with the origin that was used. */
  run: Effect.fn('cli.workflows.list')(function* (args) {
    const origin = yield* resolveOrigin({
      worktree: Option.getOrUndefined(args.worktree),
      surface: Option.getOrUndefined(args.surface),
    });
    const { workflows } = yield* call(apiEndpoints.workflows.descriptors, { origin });
    return { origin, workflows };
  }),
});

/** Every client command: the workflow engine's runs, executions, operations and checkpoints. */
export const workflowsGroup = group('workflows', {
  summary: 'Work with workflows and their runs, executions, operations and checkpoints.',
  examples: [
    { command: 'isagi workflows list --json' },
    { command: 'isagi workflows runs list --json' },
    { command: 'isagi workflows checkpoints show 5 --json' },
  ],
  commands: [list, runsGroup, executionsGroup, operationsGroup, checkpointsGroup],
});
