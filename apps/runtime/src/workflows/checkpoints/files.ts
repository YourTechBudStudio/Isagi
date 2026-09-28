import { posix } from 'node:path';
import type { Readable } from 'node:stream';

import { Effect } from 'effect';

import type { EngineRuntime } from '../engine/runtime.js';
import { WorkflowEngineError } from '../errors.js';
import { getCheckpoint, type CheckpointScope } from '../store/checkpoints.js';
import { fromJson } from '../store/rows.js';
import { checkpointNotFound } from './export.js';

/**
 * One captured file's bytes, by its destination-root-relative path, streamed from the content
 * store after the store has verified them. Structurally the route's `ContentResponse`, restated so
 * this module stays free of HTTP.
 */
export interface CheckpointFileContent {
  readonly stream: Readable;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly filename: string | null;
}

export function openCheckpointFile(
  rt: EngineRuntime,
  checkpointId: number,
  path: string,
): Effect.Effect<CheckpointFileContent, unknown> {
  return Effect.gen(function* () {
    const checkpoint = yield* rt.read('workflow_read_checkpoint', (db) =>
      getCheckpoint(db, checkpointId),
    );
    if (!checkpoint) return yield* Effect.fail(checkpointNotFound(checkpointId));
    const file = fromJson<CheckpointScope[]>(checkpoint.scopesJson)
      .flatMap((scope) => scope.files)
      .find((candidate) => candidate.path === path);
    if (!file) {
      return yield* Effect.fail(
        new WorkflowEngineError({
          code: 'workflow_checkpoint_file_not_found',
          message: `Checkpoint ${checkpointId} has no captured file '${path}'.`,
          checkpointId,
          path,
        }),
      );
    }
    const stream = yield* rt.deps.checkpoints.content.open(`sha256:${file.sha256}`).pipe(
      Effect.mapError(
        (unavailable) =>
          new WorkflowEngineError({
            code: 'workflow_checkpoint_content_unavailable',
            message: `The saved copy of '${path}' in checkpoint ${checkpointId} is ${unavailable.cause}.`,
            checkpointId,
            path,
          }),
      ),
    );
    return {
      stream,
      mediaType: 'application/octet-stream',
      byteSize: file.sizeBytes,
      filename: posix.basename(file.path),
    };
  });
}
