import { Effect } from 'effect';

import { apiEndpoints } from '@isagi/contracts';

import { CliFailure } from '../errors.js';
import { collectPages } from '../pages.js';
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
   * inventory or its layer manifest, in server order. Each page must name the checkpoint that was
   * asked for; a page for another checkpoint would silently mix two checkpoints' files.
   */
  'checkpoints inspect': ({ positionals, options }) =>
    Effect.gen(function* () {
      const params = { runId: options.run, checkpointId: positionals.checkpointId };
      const { checkpoint } = yield* call(workflows.getCheckpoint, params);
      if (options.resolved) {
        const inventory = yield* collectPages(
          (query) =>
            call(workflows.listCheckpointInventory, params, query).pipe(
              Effect.tap((page) => echoesCheckpoint(page.checkpointId, params.checkpointId)),
            ),
          (page) => page.entries,
        );
        return { checkpoint, inventory };
      }
      if (options.manifest) {
        const manifest = yield* collectPages(
          (query) =>
            call(workflows.listCheckpointManifest, params, query).pipe(
              Effect.tap((page) => echoesCheckpoint(page.checkpointId, params.checkpointId)),
            ),
          (page) => page.entries,
        );
        return { checkpoint, manifest };
      }
      return { checkpoint };
    }),
} satisfies GroupHandlers<'checkpoints'>;

function echoesCheckpoint(returned: string, requested: string) {
  return returned === requested
    ? Effect.void
    : Effect.fail(
        CliFailure.of(
          'runtime_response_invalid',
          `The runtime returned a page for checkpoint ${returned} while ${requested} was requested.`,
          { requestedCheckpointId: requested, returnedCheckpointId: returned },
        ),
      );
}
