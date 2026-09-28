import { resolve } from 'node:path';

import { Effect } from 'effect';

import { apiEndpoints, workflowContentEndpoints } from '@isagi/contracts';

import { streamContent } from '../content-stream.js';
import { CliContext } from '../context.js';
import { causeText, CliFailure, errnoOf, writeFailure } from '../errors.js';
import { call, callContent } from '../runtime-api.js';
import type { GroupHandlers } from './handlers.js';
import { compact } from './query.js';

const workflows = apiEndpoints.workflows;

export const checkpointsHandlers = {
  'checkpoints list': ({ options }) =>
    call(
      workflows.listCheckpoints,
      { runId: options.run },
      compact({
        scope: options.scope,
        executionId: options.execution,
        cursor: options.cursor,
        limit: options.limit,
      }),
    ),

  'checkpoints show': ({ positionals }) =>
    call(workflows.getCheckpoint, { checkpointId: positionals.checkpointId }),

  /**
   * The captured bytes, unchanged, on stdout. The runtime verifies them before its first byte, so a
   * refusal arrives as an error envelope; a failure after bytes have started can only be a cut
   * stream, reported on stderr, and whatever reached stdout may be truncated.
   */
  'checkpoints read': ({ positionals }) =>
    Effect.gen(function* () {
      const io = yield* CliContext;
      const response = yield* callContent(
        workflowContentEndpoints.getCheckpointFile,
        { checkpointId: positionals.checkpointId },
        { path: positionals.path },
      );
      yield* streamContent(response.body, io.stdout, { end: false }).pipe(
        Effect.catchAll((failure) => {
          // A reader that stopped early (`| head`) is the reader's choice, not a failure.
          if (failure.side === 'destination' && errnoOf(failure.cause) === 'EPIPE') {
            return Effect.void;
          }
          return Effect.fail(
            failure.side === 'source'
              ? CliFailure.of(
                  'runtime_unreachable',
                  'The checkpoint file stream failed part-way; stdout may be truncated.',
                  {
                    checkpointId: positionals.checkpointId,
                    path: positionals.path,
                    cause: causeText(failure.cause),
                  },
                )
              : writeFailure('<stdout>', failure.cause),
          );
        }),
      );
      return undefined;
    }),

  /** One runtime call: the runtime checks the folder, creates it and writes every captured scope. */
  'checkpoints export': ({ positionals, options }) =>
    Effect.gen(function* () {
      const io = yield* CliContext;
      return yield* call(
        workflows.exportCheckpoint,
        { checkpointId: positionals.checkpointId },
        { destinationPath: resolve(io.cwd, options.output) },
      );
    }),
} satisfies GroupHandlers<'checkpoints'>;
