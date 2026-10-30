import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Effect, Option } from 'effect';
import { Flag } from 'effect/cli';

import { apiEndpoints, type WorkflowPlacementRequestDto } from '@isagi/contracts';

import { CliContext } from '../context.js';
import { causeText, CliFailure } from '../errors.js';
import { call } from '../runtime-api.js';
import { clientCommand, group } from './define.js';
import { cursorFlag, limitFlag, originSurfaceFlag, originWorktreeFlag } from './flags.js';
import { resolveOrigin } from './origin.js';
import { compact } from './query.js';
import {
  argument,
  flag,
  nonEmptyText,
  positiveInteger,
  runStatus,
  surfacePlacement,
  worktreePlacement,
} from './values.js';

const workflows = apiEndpoints.workflows;

const runId = argument(positiveInteger('runId'), 'The run.');

/** A verb that takes only a run id and calls one route with it. */
function runAction(
  verb: string,
  summary: string,
  endpoint:
    | typeof workflows.getRun
    | typeof workflows.pause
    | typeof workflows.resume
    | typeof workflows.retry
    | typeof workflows.cancel,
) {
  return clientCommand(verb, {
    summary,
    examples: [{ command: `isagi workflows runs ${verb} 42 --json` }],
    config: { runId },
    run: (args) => call(endpoint, { runId: args.runId }),
  });
}

const launch = clientCommand('launch', {
  summary: 'Start a fresh run of a workflow, with explicit inputs and placement.',
  examples: [
    {
      command: `isagi workflows runs launch implement-story --inputs '{"story":47}' --json`,
      description: 'Launch from the worktree containing the current directory',
    },
    {
      command:
        'isagi workflows runs launch implement-story --inputs @inputs.json --worktree-placement existing:31 --surface-placement create:Experiment --json',
      description: 'Choose where the run works instead of the workflow’s placement hook',
    },
  ],
  config: {
    workflowKey: argument(nonEmptyText('workflowKey'), 'The workflow to launch.'),
    inputs: flag(
      'inputs',
      nonEmptyText('json|@file'),
      'The run inputs: a JSON object, or @<path> to a file holding one (relative to the current directory).',
    ).pipe(Flag.optional),
    worktreePlacement: flag(
      'worktree-placement',
      worktreePlacement,
      'current | existing:<worktreeId> | create:<branch>:<fromRef>. Give with --surface-placement.',
    ).pipe(Flag.optional),
    surfacePlacement: flag(
      'surface-placement',
      surfacePlacement,
      'current | existing:<surfaceId> | create:<title>. Give with --worktree-placement.',
    ).pipe(Flag.optional),
    worktree: originWorktreeFlag,
    surface: originSurfaceFlag,
  },
  requires: [
    ['worktreePlacement', 'surfacePlacement'],
    ['surfacePlacement', 'worktreePlacement'],
    ['surface', 'worktree'],
  ],
  /**
   * Inputs are read and checked before any request. Placement is sent only when both halves are
   * given; otherwise the workflow's own `placement` hook decides, and the placement actually used
   * is read later with `workflows runs show`.
   */
  run: Effect.fn('cli.runs.launch')(function* (args) {
    const inputs = Option.isSome(args.inputs) ? yield* readInputs(args.inputs.value) : undefined;
    const placement: WorkflowPlacementRequestDto | null =
      Option.isSome(args.worktreePlacement) && Option.isSome(args.surfacePlacement)
        ? { worktree: args.worktreePlacement.value, surface: args.surfacePlacement.value }
        : null;
    const origin = yield* resolveOrigin({
      worktree: Option.getOrUndefined(args.worktree),
      surface: Option.getOrUndefined(args.surface),
    });
    const started = yield* call(workflows.start, {
      workflowKey: args.workflowKey,
      origin,
      ...(inputs === undefined ? {} : { inputs }),
      ...(placement === null ? {} : { placement }),
    });
    return { runId: started.runId, workflowKey: started.workflowKey, origin, placement };
  }),
});

const list = clientCommand('list', {
  summary: 'List runs, newest first.',
  examples: [
    { command: 'isagi workflows runs list --json' },
    {
      command: 'isagi workflows runs list --workflow implement-story --status failed --json',
      description: 'Failed runs of one workflow',
    },
  ],
  config: {
    workflow: flag('workflow', nonEmptyText('workflowKey'), 'Only runs of this workflow key.').pipe(
      Flag.optional,
    ),
    status: flag('status', runStatus, 'Only runs in this status.').pipe(Flag.optional),
    cursor: cursorFlag,
    limit: limitFlag,
  },
  run: (args) =>
    call(
      workflows.listRuns,
      compact({
        workflowKey: Option.getOrUndefined(args.workflow),
        status: Option.getOrUndefined(args.status),
        cursor: Option.getOrUndefined(args.cursor),
        limit: Option.getOrUndefined(args.limit),
      }),
    ),
});

const structure = clientCommand('structure', {
  summary: "Show a run's declared workflow structure, at its current build or at one it used.",
  examples: [
    { command: 'isagi workflows runs structure 42 --json' },
    { command: 'isagi workflows runs structure 42 --artifact-hash sha256:abc --json' },
  ],
  config: {
    runId,
    artifactHash: flag(
      'artifact-hash',
      nonEmptyText('hash'),
      'A build the run used, instead of its current one.',
    ).pipe(Flag.optional),
  },
  run: (args) =>
    call(
      workflows.getStructure,
      { runId: args.runId },
      compact({ artifactHash: Option.getOrUndefined(args.artifactHash) }),
    ),
});

const events = clientCommand('events', {
  summary: "List a run's event log: node steps, waits, pauses, code reloads, retries, logs.",
  examples: [
    { command: 'isagi workflows runs events 42 --json' },
    { command: 'isagi workflows runs events 42 --cursor 120 --json', description: 'The next page' },
  ],
  config: { runId, cursor: cursorFlag, limit: limitFlag },
  run: (args) =>
    call(
      workflows.listEvents,
      { runId: args.runId },
      compact({
        cursor: Option.getOrUndefined(args.cursor),
        limit: Option.getOrUndefined(args.limit),
      }),
    ),
});

export const runsGroup = group('runs', {
  summary: 'Launch, inspect and control workflow runs.',
  examples: [
    { command: 'isagi workflows runs list --json' },
    { command: 'isagi workflows runs show 42 --json' },
  ],
  commands: [
    launch,
    list,
    runAction(
      'show',
      'Show a run: its summary, inputs, and every graph invocation and execution.',
      workflows.getRun,
    ),
    structure,
    events,
    runAction('pause', 'Pause a run.', workflows.pause),
    runAction(
      'resume',
      'Resume a paused run on the latest verified build of its workflow.',
      workflows.resume,
    ),
    runAction(
      'retry',
      'Retry a failed run on the latest verified build of its workflow.',
      workflows.retry,
    ),
    runAction('cancel', 'Cancel a run.', workflows.cancel),
  ],
});

/**
 * `--inputs`: JSON text, or `@<path>` naming a file (relative to the current directory) that holds
 * it. It must be a JSON object; everything beyond that is the runtime's to judge against the
 * workflow's own input schema.
 */
const readInputs = Effect.fn('cli.runs.readInputs')(function* (raw: string) {
  const io = yield* CliContext;
  const source = raw.startsWith('@')
    ? yield* Effect.tryPromise({
        try: () => readFile(resolve(io.cwd, raw.slice(1)), 'utf8'),
        catch: (cause) =>
          CliFailure.of(
            'cli_usage_invalid',
            `--inputs ${raw}: the file cannot be read (${causeText(cause)}).`,
            {
              context: { flag: '--inputs', path: resolve(io.cwd, raw.slice(1)) },
              recovery: 'Point --inputs @<path> at a readable JSON file, or pass the JSON inline.',
            },
          ),
      })
    : raw;
  const value = yield* Effect.try({
    try: () => JSON.parse(source) as unknown,
    catch: (cause) =>
      CliFailure.of('cli_usage_invalid', `--inputs is not valid JSON: ${causeText(cause)}`, {
        context: { flag: '--inputs' },
        recovery: 'Pass a JSON object, such as \'{"story":47}\', or @<path> to a file holding one.',
      }),
  });
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return yield* CliFailure.of('cli_usage_invalid', '--inputs must be a JSON object.', {
      context: { flag: '--inputs' },
      recovery: 'Pass a JSON object, such as \'{"story":47}\', or @<path> to a file holding one.',
    });
  }
  return value as Record<string, unknown>;
});
