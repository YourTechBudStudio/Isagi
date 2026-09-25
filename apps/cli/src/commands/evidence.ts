import { open, rm, type FileHandle } from 'node:fs/promises';
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

export const evidenceHandlers = {
  'evidence list': ({ options }) =>
    call(
      workflows.listEvidence,
      { runId: options.run },
      compact({
        executionId: options.execution,
        subtree: options.descendants ? ('true' as const) : undefined,
        role: options.role,
        label: options.label.length > 0 ? options.label : undefined,
        cursor: options.cursor,
        limit: options.limit,
      }),
    ),
  'evidence inspect': ({ positionals, options }) =>
    call(workflows.getEvidence, { runId: options.run, evidenceKey: positionals.evidenceKey }),

  /**
   * The captured bytes, unchanged, on stdout. The runtime verifies content before its first byte,
   * so a refusal arrives as an error envelope; a failure after bytes have started can only be a cut
   * stream, reported on stderr, and whatever reached stdout may be truncated.
   */
  'evidence read': ({ positionals, options }) =>
    Effect.gen(function* () {
      const io = yield* CliContext;
      const response = yield* callContent(workflowContentEndpoints.getEvidenceContent, {
        runId: options.run,
        evidenceKey: positionals.evidenceKey,
      });
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
                  'The evidence content stream failed part-way; stdout may be truncated.',
                  { evidenceKey: positionals.evidenceKey, cause: causeText(failure.cause) },
                )
              : writeFailure('<stdout>', failure.cause),
          );
        }),
      );
      return undefined;
    }),

  /**
   * The captured bytes in a new file the caller names. The file is created exclusively, so an
   * existing file is never overwritten, and a file this command created is removed again if the
   * bytes do not arrive complete.
   */
  'evidence export': ({ positionals, options }) =>
    Effect.gen(function* () {
      const io = yield* CliContext;
      const { evidence } = yield* call(workflows.getEvidence, {
        runId: options.run,
        evidenceKey: positionals.evidenceKey,
      });
      const outputPath = resolve(io.cwd, options.output);
      const handle = yield* Effect.tryPromise({
        try: () => open(outputPath, 'wx'),
        catch: (cause) =>
          errnoOf(cause) === 'EEXIST'
            ? CliFailure.of('output_exists', `${outputPath} already exists.`, {
                path: outputPath,
              })
            : writeFailure(outputPath, cause),
      });

      const content = callContent(workflowContentEndpoints.getEvidenceContent, {
        runId: options.run,
        evidenceKey: positionals.evidenceKey,
      });
      yield* streamInto(handle, outputPath, content).pipe(
        Effect.flatMap((written) =>
          written === evidence.content.byteSize
            ? Effect.void
            : Effect.fail(
                CliFailure.of(
                  'content_integrity_mismatch',
                  `Received ${written} bytes for ${evidence.evidenceKey}; the record says ${evidence.content.byteSize}.`,
                  {
                    path: outputPath,
                    expectedBytes: evidence.content.byteSize,
                    receivedBytes: written,
                  },
                ),
              ),
        ),
        Effect.tapError(() => Effect.promise(() => rm(outputPath, { force: true }))),
      );
      return { outputPath, evidence };
    }),
} satisfies GroupHandlers<'evidence'>;

/** Streams one content response into an open file, closes it, and returns the byte count written. */
function streamInto<R>(
  handle: FileHandle,
  path: string,
  content: Effect.Effect<Response, CliFailure, R>,
): Effect.Effect<number, CliFailure, R> {
  return Effect.gen(function* () {
    const response = yield* content;
    return yield* streamContent(response.body, handle.createWriteStream(), { end: true }).pipe(
      Effect.mapError((failure) =>
        failure.side === 'source'
          ? CliFailure.of('runtime_unreachable', 'The content stream failed part-way.', {
              path,
              cause: causeText(failure.cause),
            })
          : writeFailure(path, failure.cause),
      ),
    );
  }).pipe(
    // The write stream closes the handle once it finishes; this closes it when streaming never began
    // (a refused content request) and is a no-op otherwise.
    Effect.ensuring(Effect.promise(() => handle.close().catch(() => undefined))),
  );
}
