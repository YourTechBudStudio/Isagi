import { Effect } from 'effect';

import { apiEndpoints } from '@isagi/contracts';

import { exportCheckpoint, exportSummaryText } from '../checkpoint-export/index.js';
import { readInventory, readManifest } from '../checkpoint-reads.js';
import { CliContext } from '../context.js';
import { CommandResult } from '../output.js';
import { call } from '../runtime-api.js';
import type { GroupHandlers } from './handlers.js';
import { compact } from './query.js';

const workflows = apiEndpoints.workflows;

export const checkpointsHandlers = {
  'checkpoints list': ({ options }) =>
    call(
      workflows.listCheckpoints,
      { runId: options.run },
      compact({
        executionId: options.execution,
        descendants: options.descendants ? ('true' as const) : undefined,
        cursor: options.cursor,
        limit: options.limit,
      }),
    ),

  /**
   * A checkpoint's detail, plus — in `--resolved` or `--manifest` mode — every page of its final
   * inventory or its layer manifest, in server order.
   */
  'checkpoints inspect': ({ positionals, options }) =>
    Effect.gen(function* () {
      const params = { runId: options.run, checkpointId: positionals.checkpointId };
      const { checkpoint } = yield* call(workflows.getCheckpoint, params);
      if (options.resolved) return { checkpoint, inventory: yield* readInventory(params) };
      if (options.manifest) return { checkpoint, manifest: yield* readManifest(params) };
      return { checkpoint };
    }),

  /**
   * The checkpoint's files rebuilt under an empty folder. The result is printed on every outcome
   * past argument parsing and targeting, including failures; `failed` and `uncertain` exit 1.
   * Progress goes to stderr.
   */
  'checkpoints export': ({ positionals, options }) =>
    Effect.gen(function* () {
      const io = yield* CliContext;
      const result = yield* exportCheckpoint({
        runId: options.run,
        checkpointId: positionals.checkpointId,
        output: options.output,
        cwd: io.cwd,
        progress: (line) => io.stderr.write(`${line}\n`),
      });
      return new CommandResult({
        value: result,
        exitCode: result.status === 'complete' ? 0 : 1,
        text: exportSummaryText(result),
      });
    }),
} satisfies GroupHandlers<'checkpoints'>;
