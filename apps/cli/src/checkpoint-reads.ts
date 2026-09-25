import { Effect } from 'effect';

import { apiEndpoints } from '@isagi/contracts';

import { CliFailure } from './errors.js';
import { collectPages } from './pages.js';
import { call } from './runtime-api.js';

const workflows = apiEndpoints.workflows;

export interface CheckpointParams {
  readonly runId: number;
  readonly checkpointId: string;
}

/**
 * Every page of a checkpoint's resolved inventory, in server order. Shared by `checkpoints inspect
 * --resolved` and `checkpoints export`, so what an agent inspects is exactly what export applies.
 */
export function readInventory(params: CheckpointParams) {
  return collectPages(
    (query) =>
      call(workflows.listCheckpointInventory, params, query).pipe(
        Effect.tap((page) => echoesCheckpoint(page.checkpointId, params.checkpointId)),
      ),
    (page) => page.entries,
  );
}

/** Every page of a checkpoint's layer manifest, in server order. Inspection only; never applied. */
export function readManifest(params: CheckpointParams) {
  return collectPages(
    (query) =>
      call(workflows.listCheckpointManifest, params, query).pipe(
        Effect.tap((page) => echoesCheckpoint(page.checkpointId, params.checkpointId)),
      ),
    (page) => page.entries,
  );
}

/** A page for another checkpoint would silently mix two checkpoints' files. */
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
