/**
 * `checkpoints export`: rebuild one checkpoint's files under an empty folder.
 *
 * The runtime owns checkpoint resolution and Git; this module composes bounded calls and applies
 * final files. It never runs Git, never reads the manifest, never visits ancestor checkpoints, and
 * never uses a commit other than the checkpoint's own `base`. It never launches anything either.
 *
 * `exportCheckpoint` is the only public surface. Every outcome — success, failure, or a request
 * whose effect is unknown — is an `ExportResult`, so the caller always has something honest to
 * print and never a bare error.
 */
import { lstat, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { Data, Effect } from 'effect';

import {
  apiEndpoints,
  workflowContentEndpoints,
  type WorkflowCheckpointBase,
  type WorkflowCheckpointCounts,
  type WorkflowCheckpointWarningReason,
} from '@isagi/contracts';
import {
  RuntimeApiError,
  RuntimeTransportError,
  type RuntimeClientError,
} from '@isagi/runtime-client';

import { readInventory } from '../checkpoint-reads.js';
import { CliFailure, fromRuntimeError, writeFailure, type ErrorDocument } from '../errors.js';
import { call, callContent, RuntimeApi, type RuntimeApiService } from '../runtime-api.js';
import { applyAbsence, writeFile } from './apply.js';
import { resolveDestination } from './destination.js';
import { planExport, type InventoryProblem, type WarningEntry } from './plan.js';
import {
  limitationsFor,
  type ExportCreated,
  type ExportResult,
  type ExportStage,
  type ExportStatus,
} from './result.js';

export { runtimeApiLayer } from '../runtime-api.js';
export {
  exportLimitationSchema,
  exportStageSchema,
  exportSummaryText,
  type ExportCreated,
  type ExportFailure,
  type ExportLimitation,
  type ExportResult,
  type ExportStage,
} from './result.js';

export interface ExportCheckpointInput {
  readonly runId: number;
  readonly checkpointId: string;
  /** The destination as the caller typed it, resolved against `cwd`. */
  readonly output: string;
  readonly cwd: string;
  /** One line per stage, and `wrote <n>/<m> files` at most once a second. Never data. */
  readonly progress: (line: string) => void;
}

/** How many files are written at once. Failing fast interrupts the rest and removes their temp files. */
const writeConcurrency = 8;

export function exportCheckpoint(
  input: ExportCheckpointInput,
): Effect.Effect<ExportResult, never, RuntimeApiService> {
  const state = {
    destinationPath: resolve(input.cwd, input.output),
    base: null as WorkflowCheckpointBase | null,
    worktreeId: null as number | null,
    counts: null as WorkflowCheckpointCounts | null,
    applied: { files: 0, absences: 0 },
    resolvedWarningCounts: {} as Partial<Record<WorkflowCheckpointWarningReason, number>>,
    /** A directory-only export's "destination is non-empty": set by every entry it creates. */
    wroteEntry: false,
  };
  const params = { runId: input.runId, checkpointId: input.checkpointId };

  /** What a failure at this point leaves on disk; see `ExportCreated`. */
  const createdAfterBaseline = (): ExportCreated =>
    state.base?.kind === 'git'
      ? { destination: true, worktreeId: state.worktreeId }
      : { destination: state.wroteEntry, worktreeId: null };
  const nothingCreated: ExportCreated = { destination: false, worktreeId: null };

  const stage = <A, R>(
    name: ExportStage,
    work: Effect.Effect<A, CliFailure | ExportStop, R>,
    created: () => ExportCreated,
  ): Effect.Effect<A, ExportStop, R> => {
    input.progress(`${name}…`);
    return work.pipe(
      Effect.mapError((error) =>
        error instanceof ExportStop
          ? error
          : new ExportStop({
              stage: name,
              document: error.document,
              created: created(),
              uncertain: false,
            }),
      ),
    );
  };

  const program = Effect.gen(function* () {
    const destination = yield* stage(
      'resolve_destination',
      resolveDestination({ runId: input.runId, output: input.output, cwd: input.cwd }),
      () => nothingCreated,
    );
    state.destinationPath = destination;

    const entries = yield* stage(
      'read_checkpoint',
      Effect.gen(function* () {
        const { checkpoint } = yield* call(apiEndpoints.workflows.getCheckpoint, params);
        state.base = checkpoint.base;
        state.counts = checkpoint.counts;
        const inventory = yield* readInventory(params);
        state.resolvedWarningCounts = resolvedWarningCounts(
          inventory.filter((entry): entry is WarningEntry => entry.kind === 'warning'),
        );
        return inventory;
      }),
      () => nothingCreated,
    );

    const plan = yield* stage(
      'validate_inventory',
      Effect.suspend(() => {
        const outcome = planExport(entries);
        return outcome.ok
          ? Effect.succeed(outcome.plan)
          : Effect.fail(inventoryFailure(outcome.problem));
      }),
      () => nothingCreated,
    );

    const root = yield* stage(
      'prepare_baseline',
      state.base!.kind === 'git'
        ? prepareGitBaseline(params, destination, state.base!, (worktreeId) => {
            state.worktreeId = worktreeId;
          })
        : Effect.tryPromise({
            try: () => mkdir(destination, { recursive: true }),
            catch: (cause) => writeFailure(destination, cause),
          }).pipe(Effect.as(destination)),
      // Only a directory-only `mkdir` fails as a plain `CliFailure` here. The destination was
      // absent or empty, and a failed `mkdir` writes nothing into it.
      () => nothingCreated,
    );
    state.destinationPath = root;

    yield* stage(
      'apply_absences',
      Effect.forEach(
        plan.absences,
        (absence) =>
          applyAbsence(root, absence).pipe(
            Effect.tap(() => {
              state.applied.absences += 1;
            }),
          ),
        { discard: true },
      ),
      createdAfterBaseline,
    );

    const total = plan.files.length;
    let lastReport = Date.now();
    yield* stage(
      'write_files',
      Effect.forEach(
        plan.files,
        (file) =>
          writeFile(
            root,
            file,
            callContent(workflowContentEndpoints.getCheckpointFileContent, {
              ...params,
              fileId: file.fileId,
            }),
            () => {
              state.wroteEntry = true;
            },
          ).pipe(
            Effect.tap(() => {
              state.applied.files += 1;
              const now = Date.now();
              if (now - lastReport >= 1000) {
                lastReport = now;
                input.progress(`wrote ${state.applied.files}/${total} files`);
              }
            }),
          ),
        { concurrency: writeConcurrency, discard: true },
      ),
      createdAfterBaseline,
    );
  });

  return program.pipe(
    Effect.map((): ExportResult => result('complete', null)),
    Effect.catchAll((stop) =>
      Effect.succeed(
        result(stop.uncertain ? 'uncertain' : 'failed', {
          ...stop.document,
          stage: stop.stage,
          created: stop.created,
        }),
      ),
    ),
  );

  function result(status: ExportStatus, failure: ExportResult['failure']): ExportResult {
    return {
      status,
      runId: input.runId,
      checkpointId: input.checkpointId,
      destinationPath: state.destinationPath,
      base: state.base,
      worktreeId: state.worktreeId,
      counts: state.counts,
      applied: { ...state.applied },
      resolvedWarningCounts: state.resolvedWarningCounts,
      limitations: limitationsFor(state.base),
      failure,
    };
  }
}

/**
 * A stage that stopped the export, with what it left behind. `uncertain` only when the runtime may
 * or may not have acted on a request.
 */
class ExportStop extends Data.TaggedError('ExportStop')<{
  readonly stage: ExportStage;
  readonly document: ErrorDocument;
  readonly created: ExportCreated;
  readonly uncertain: boolean;
}> {}

/**
 * `prepare_baseline` for a Git base: the runtime creates a detached worktree at the checkpoint's
 * own commit, at exactly the canonical path this export checked.
 *
 * The answer is checked before anything is written: the base must be the checkpoint's, the path
 * must be the one requested (so every later write lands where `resolve_destination` looked), and
 * the worktree must be visible here (the same-machine prerequisite). A failed check leaves the
 * worktree in place and reports it.
 */
function prepareGitBaseline(
  params: { readonly runId: number; readonly checkpointId: string },
  destination: string,
  base: Extract<WorkflowCheckpointBase, { readonly kind: 'git' }>,
  onWorktree: (worktreeId: number) => void,
): Effect.Effect<string, ExportStop, RuntimeApiService> {
  return Effect.gen(function* () {
    const api = yield* RuntimeApi;
    const endpoint = apiEndpoints.workflows.createCheckpointWorktree;
    const created = yield* api
      .request(endpoint, params, { destinationPath: destination })
      .pipe(
        Effect.mapError((error) =>
          postFailure(
            error,
            fromRuntimeError(error, { endpointId: endpoint.id, runtimeUrl: api.runtimeUrl }),
          ),
        ),
      );
    onWorktree(created.worktreeId);
    const kept = { destination: true, worktreeId: created.worktreeId } as const;
    const stop = (failure: CliFailure) =>
      new ExportStop({
        stage: 'prepare_baseline',
        document: failure.document,
        created: kept,
        uncertain: false,
      });

    if (
      created.base.commitSha !== base.commitSha ||
      created.base.repositoryId !== base.repositoryId
    ) {
      return yield* Effect.fail(
        stop(
          CliFailure.of(
            'runtime_response_invalid',
            'The runtime created a worktree at a different base than the checkpoint names.',
            { expectedBase: base, returnedBase: created.base, worktreeId: created.worktreeId },
          ),
        ),
      );
    }
    if (created.destinationPath !== destination) {
      return yield* Effect.fail(
        stop(
          CliFailure.of(
            'runtime_response_invalid',
            'The runtime created the worktree at a different path than the one requested.',
            {
              requestedPath: destination,
              returnedPath: created.destinationPath,
              worktreeId: created.worktreeId,
            },
          ),
        ),
      );
    }
    const visible = yield* Effect.promise(() =>
      lstat(join(created.destinationPath, '.git')).then(
        () => true,
        () => false,
      ),
    );
    if (!visible) {
      return yield* Effect.fail(
        stop(
          CliFailure.of(
            'export_destination_not_visible',
            `The runtime reports a worktree at ${created.destinationPath}, but it is not visible here; the CLI must run on the runtime's machine.`,
            { destinationPath: created.destinationPath, worktreeId: created.worktreeId },
          ),
        ),
      );
    }
    return created.destinationPath;
  });
}

/**
 * What a failed worktree request leaves behind. Never a retry and never a cleanup.
 *
 * - A `workflow_rejected` answer is authoritative: `workflow_checkpoint_worktree_failed` says whether
 *   something was created, and every other reason is a check made before anything was written.
 * - Any other error code (a Git or database failure, say) may come after Git created the worktree,
 *   so what exists is unknown; the status is still `failed`, because the runtime did answer.
 * - A refused connection never reached the runtime. Any other transport or decoding failure
 *   happened after the request was sent, so the runtime may or may not have acted: `uncertain`.
 */
function postFailure(error: RuntimeClientError, failure: CliFailure): ExportStop {
  const at = (created: ExportCreated, uncertain = false) =>
    new ExportStop({ stage: 'prepare_baseline', document: failure.document, created, uncertain });
  if (error instanceof RuntimeApiError) {
    const apiError = error.apiError as { readonly code: string; readonly data?: unknown };
    if (apiError.code !== 'workflow_rejected') return at({ destination: null, worktreeId: null });
    const data = apiError.data as
      | { readonly reason?: string; readonly created?: boolean }
      | undefined;
    return data?.reason === 'workflow_checkpoint_worktree_failed'
      ? at({ destination: data.created ?? null, worktreeId: null })
      : at({ destination: false, worktreeId: null });
  }
  if (error instanceof RuntimeTransportError && hasErrno(error.cause, 'ECONNREFUSED')) {
    return at({ destination: false, worktreeId: null });
  }
  // A transport failure other than a refused connection, or an answer that did not decode.
  return at({ destination: null, worktreeId: null }, true);
}

/** Whether a failure, or any cause beneath it (fetch wraps the socket error), carries `code`. */
function hasErrno(cause: unknown, code: string): boolean {
  for (let current = cause, depth = 0; current && depth < 8; depth += 1) {
    if (typeof current === 'object' && 'code' in current && current.code === code) return true;
    if (
      current instanceof AggregateError &&
      current.errors.some((inner) => hasErrno(inner, code))
    ) {
      return true;
    }
    current = typeof current === 'object' && 'cause' in current ? current.cause : undefined;
  }
  return false;
}

/**
 * R14: how many paths or observations each warning reason affects across the resolved inventory,
 * inherited region warnings included. This follows the runtime's `warningGroupsOf`
 * (`apps/runtime/src/workflows/checkpoints/warning-groups.ts`, runtime-private, so reproduced here):
 * each warning entry adds 1 to its reason, and the `warnings_truncated` sentinel is never a key — its
 * `detail.omitted` joins `uncaptured_dirty_path`, the one reason ever capped. Unlike that function,
 * every warning counts, not only the checkpoint's own observations.
 */
function resolvedWarningCounts(
  warnings: readonly WarningEntry[],
): Partial<Record<WorkflowCheckpointWarningReason, number>> {
  const counts: Partial<Record<WorkflowCheckpointWarningReason, number>> = {};
  const add = (reason: WorkflowCheckpointWarningReason, amount: number) => {
    if (amount > 0) counts[reason] = (counts[reason] ?? 0) + amount;
  };
  for (const warning of warnings) {
    if (warning.reason === 'warnings_truncated') {
      const omitted = warning.detail?.omitted;
      add('uncaptured_dirty_path', typeof omitted === 'number' ? omitted : 0);
    } else {
      add(warning.reason, 1);
    }
  }
  return counts;
}

function inventoryFailure(problem: InventoryProblem): CliFailure {
  switch (problem.kind) {
    case 'unsafe_path':
      return CliFailure.of(
        'export_path_unsafe',
        `The inventory path ${JSON.stringify(problem.path)} is not a safe root-relative path (${problem.rule}).`,
        { path: problem.path, rule: problem.rule },
      );
    case 'duplicate_file':
      return CliFailure.of(
        'export_inventory_conflict',
        `The inventory lists ${problem.path} twice.`,
        {
          conflict: problem.kind,
          path: problem.path,
        },
      );
    case 'file_and_absence':
      return CliFailure.of(
        'export_inventory_conflict',
        `The inventory lists ${problem.path} as both a file and an absence.`,
        { conflict: problem.kind, path: problem.path },
      );
    case 'file_is_directory_prefix':
      return CliFailure.of(
        'export_inventory_conflict',
        `The inventory lists ${problem.path} as a file and as a directory of ${problem.other}.`,
        { conflict: problem.kind, path: problem.path, other: problem.other },
      );
    case 'folding_collision':
      return CliFailure.of(
        'export_inventory_conflict',
        `${problem.path} and ${problem.other} name the same file on a case-insensitive or normalizing filesystem.`,
        { conflict: problem.kind, path: problem.path, other: problem.other },
      );
  }
}
