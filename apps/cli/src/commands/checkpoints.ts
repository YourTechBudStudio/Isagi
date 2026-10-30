import { resolve } from 'node:path';

import { Effect, Option, Stream } from 'effect';
import { Flag } from 'effect/cli';

import { apiEndpoints, workflowContentEndpoints } from '@isagi/contracts';

import { streamContent } from '../content-stream.js';
import { CliContext } from '../context.js';
import { causeText, CliFailure, errnoOf, writeFailure } from '../errors.js';
import { call, callContent } from '../runtime-api.js';
import { clientCommand, group } from './define.js';
import { cursorFlag, limitFlag, runFlag } from './flags.js';
import { compact } from './query.js';
import { argument, flag, nonEmptyText, positiveInteger } from './values.js';

const workflows = apiEndpoints.workflows;

const checkpointId = argument(positiveInteger('checkpointId'), 'The checkpoint.');

const list = clientCommand('list', {
  summary: "List a run's checkpoints, with each scope's file count.",
  examples: [
    { command: 'isagi workflows checkpoints list --run 42 --json' },
    {
      command: 'isagi workflows checkpoints list --run 42 --scope plan --json',
      description: 'Only checkpoints that captured the plan scope',
    },
  ],
  config: {
    run: runFlag,
    scope: flag(
      'scope',
      nonEmptyText('scope'),
      'Only checkpoints that captured a scope with this name.',
    ).pipe(Flag.optional),
    execution: flag(
      'execution',
      positiveInteger('executionId'),
      'Only the checkpoint this execution saved.',
    ).pipe(Flag.optional),
    cursor: cursorFlag,
    limit: limitFlag,
  },
  run: (args) =>
    call(
      workflows.listCheckpoints,
      { runId: args.run },
      compact({
        scope: Option.getOrUndefined(args.scope),
        executionId: Option.getOrUndefined(args.execution),
        cursor: Option.getOrUndefined(args.cursor),
        limit: Option.getOrUndefined(args.limit),
      }),
    ),
});

const show = clientCommand('show', {
  summary: 'Show a checkpoint: its commit, scopes, captured files and missing markers.',
  examples: [{ command: 'isagi workflows checkpoints show 5 --json' }],
  config: { checkpointId },
  run: (args) => call(workflows.getCheckpoint, { checkpointId: args.checkpointId }),
});

const read = clientCommand('read', {
  summary: "Write one captured file's bytes to stdout.",
  examples: [
    { command: 'isagi workflows checkpoints read 5 scratch/plan.md' },
    {
      command: 'isagi workflows checkpoints read 5 scratch/plan.md > plan.md',
      description: 'Save the captured file',
    },
  ],
  config: {
    checkpointId,
    path: argument(nonEmptyText('path'), 'The captured file, relative to its scope root.'),
  },
  stdout: 'raw',
  /**
   * The captured bytes, unchanged, on stdout. The runtime verifies them before its first byte, so a
   * refusal arrives as an error envelope; a failure after bytes have started can only be a cut
   * stream, reported on stderr, and whatever reached stdout may be truncated.
   */
  run: Effect.fn('cli.checkpoints.read')(function* (args) {
    const io = yield* CliContext;
    const content = yield* callContent(
      workflowContentEndpoints.getCheckpointFile,
      { checkpointId: args.checkpointId },
      { path: args.path },
    );
    // A cut body is reported by the platform error behind it (`terminated: other side closed`), not
    // by the client's generic transport message.
    const body = content.stream.pipe(Stream.mapError((error) => error.cause));
    yield* streamContent(body, io.stdout).pipe(
      Effect.catch((failure) => {
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
                  context: {
                    checkpointId: args.checkpointId,
                    path: args.path,
                    cause: causeText(failure.cause),
                  },
                },
              )
            : writeFailure('<stdout>', failure.cause),
        );
      }),
    );
    return undefined;
  }),
});

const exportCommand = clientCommand('export', {
  summary:
    'Rebuild a checkpoint in a new folder: a detached worktree at its commit, or a plain folder.',
  examples: [{ command: 'isagi workflows checkpoints export 5 --output ../rebuilt --json' }],
  config: {
    checkpointId,
    output: flag(
      'output',
      nonEmptyText('dir'),
      'The new folder: absent or empty, and outside every checkout. Relative to the current directory.',
    ),
  },
  /** One runtime call: the runtime checks the folder, creates it and writes every captured scope. */
  run: Effect.fn('cli.checkpoints.export')(function* (args) {
    const io = yield* CliContext;
    return yield* call(
      workflows.exportCheckpoint,
      { checkpointId: args.checkpointId },
      { destinationPath: resolve(io.cwd, args.output) },
    );
  }),
});

export const checkpointsGroup = group('checkpoints', {
  summary: "Read and rebuild a run's checkpoints: the files each one captured.",
  examples: [
    { command: 'isagi workflows checkpoints list --run 42 --json' },
    { command: 'isagi workflows checkpoints read 5 scratch/plan.md' },
  ],
  commands: [list, show, read, exportCommand],
});
