import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Effect } from 'effect';

import { apiEndpoints, type WorkflowPlacementRequestDto } from '@isagi/contracts';

import { CliContext } from '../context.js';
import { causeText, CliFailure } from '../errors.js';
import { call } from '../runtime-api.js';
import type { GroupHandlers } from './handlers.js';
import { resolveOrigin } from './origin.js';
import { compact } from './query.js';

const workflows = apiEndpoints.workflows;

export const runsHandlers = {
  'runs list': ({ options }) =>
    call(
      workflows.listRuns,
      compact({
        workflowKey: options.workflow,
        status: options.status,
        cursor: options.cursor,
        limit: options.limit,
      }),
    ),
  'runs inspect': ({ positionals }) => call(workflows.getRun, { runId: positionals.runId }),
  'runs versions': ({ positionals, options }) =>
    call(
      workflows.listVersions,
      { runId: positionals.runId },
      compact({ cursor: options.cursor, limit: options.limit }),
    ),
  'runs structure': ({ positionals, options }) =>
    call(
      workflows.getStructure,
      { runId: positionals.runId },
      compact({ artifactHash: options['artifact-hash'] }),
    ),
  'runs events': ({ positionals, options }) =>
    call(
      workflows.listEvents,
      { runId: positionals.runId },
      compact({ cursor: options.cursor, limit: options.limit }),
    ),
  /**
   * A fresh run. Inputs are read and checked before any request. Placement is sent only when both
   * halves are given; otherwise the workflow's own `environment` hook decides, and the placement
   * actually used is read later with `runs inspect`.
   */
  'runs launch': ({ positionals, options }) =>
    Effect.gen(function* () {
      const inputs = options.inputs === undefined ? undefined : yield* readInputs(options.inputs);
      const worktree = options['worktree-placement'];
      const surface = options['surface-placement'];
      const placement: WorkflowPlacementRequestDto | null =
        worktree !== undefined && surface !== undefined ? { worktree, surface } : null;
      const origin = yield* resolveOrigin({ worktree: options.worktree, surface: options.surface });
      const started = yield* call(workflows.start, {
        workflowKey: positionals.workflowKey,
        origin,
        ...(inputs === undefined ? {} : { inputs }),
        ...(placement === null ? {} : { placement }),
      });
      return { runId: started.runId, workflowKey: started.workflowKey, origin, placement };
    }),
  'runs pause': ({ positionals }) => call(workflows.pause, { runId: positionals.runId }),
  'runs resume': ({ positionals }) => call(workflows.resume, { runId: positionals.runId }),
  'runs retry': ({ positionals }) => call(workflows.retry, { runId: positionals.runId }),
  'runs cancel': ({ positionals }) => call(workflows.cancel, { runId: positionals.runId }),
} satisfies GroupHandlers<'runs'>;

/**
 * `--inputs`: JSON text, or `@<path>` naming a file (relative to the current directory) that holds
 * it. It must be a JSON object; everything beyond that is the runtime's to judge against the
 * workflow's own input schema.
 */
function readInputs(raw: string) {
  return Effect.gen(function* () {
    const io = yield* CliContext;
    const source = raw.startsWith('@')
      ? yield* Effect.tryPromise({
          try: () => readFile(resolve(io.cwd, raw.slice(1)), 'utf8'),
          catch: (cause) =>
            CliFailure.of(
              'cli_usage_invalid',
              `--inputs ${raw}: the file cannot be read (${causeText(cause)}).`,
            ),
        })
      : raw;
    const value = yield* Effect.try({
      try: () => JSON.parse(source) as unknown,
      catch: (cause) =>
        CliFailure.of('cli_usage_invalid', `--inputs is not valid JSON: ${causeText(cause)}`),
    });
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return yield* Effect.fail(
        CliFailure.of('cli_usage_invalid', '--inputs must be a JSON object.'),
      );
    }
    return value as Record<string, unknown>;
  });
}
