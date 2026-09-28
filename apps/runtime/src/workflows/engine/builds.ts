import { Effect } from 'effect';

import { WorkflowEngineError } from '../errors.js';
import { errorMessage } from '../state/pure.js';
import { toJson } from '../store/rows.js';
import { insertArtifact } from '../store/runs.js';
import { WorkflowLoadError, type PublishedWorkflowArtifact } from '../structure/loader.js';
import type { WorkflowRegistryContext } from '../structure/registry.js';
import type { EngineRuntime } from './runtime.js';

/**
 * The latest verified build of a workflow, as seen from a project.
 *
 * Launch, Resume and Retry all go through here: discover the package, verify it, publish its
 * artifact to the content-addressed cache, and record an artifact row so a run can point at it and
 * the inspector can describe it later without importing it.
 */
export function resolveLatestBuild(
  rt: EngineRuntime,
  workflowKey: string,
  context: WorkflowRegistryContext,
): Effect.Effect<PublishedWorkflowArtifact, WorkflowEngineError | unknown> {
  return Effect.gen(function* () {
    const snapshot = yield* rt.deps.registry.discover(context).pipe(
      Effect.mapError(
        (cause) =>
          new WorkflowEngineError({
            code: 'workflow_discovery_failed',
            message: cause.message,
            workflowKey,
            ...(cause.workflowSourceDirectory === undefined
              ? {}
              : { workflowSourceDirectory: cause.workflowSourceDirectory }),
          }),
      ),
    );
    const entry = snapshot.find(workflowKey);
    if (!entry) {
      const known = snapshot.entries.map((candidate) => candidate.workflowKey);
      return yield* Effect.fail(
        new WorkflowEngineError({
          code: 'unknown_workflow_key',
          message:
            known.length === 0
              ? `No workflow named '${workflowKey}' was found, and no workflows are available here.`
              : `No workflow named '${workflowKey}' was found. Available: ${known.join(', ')}.`,
          workflowKey,
        }),
      );
    }
    const build = yield* entry.load().pipe(
      Effect.mapError(
        (failure) =>
          new WorkflowEngineError({
            code: 'workflow_load_failed',
            message: failure instanceof WorkflowLoadError ? failure.message : errorMessage(failure),
            workflowKey,
            workflowLoadFailureReason: failure.reason,
            ...(failure.diagnostics ? { diagnostics: failure.diagnostics } : {}),
            ...(entry.provenance
              ? {
                  workflowPackageDirectory: entry.provenance.workflowPackageDirectory,
                  shadowedWorkflowPackageDirectories:
                    entry.provenance.shadowedWorkflowPackageDirectories,
                }
              : {}),
          }),
      ),
    );
    yield* rt.commit('workflow_record_artifact', (db) =>
      insertArtifact(db, {
        hash: build.artifactHash,
        workflowKey,
        sdkVersion: build.versions.sdkVersion,
        verifierVersion: build.versions.verifierVersion,
        contractVersion: build.versions.contractVersion,
        structureJson: toJson(build.descriptor),
      }),
    );
    return build;
  });
}

/** Where a project's workflows are discovered from. */
export function projectContext(
  rt: EngineRuntime,
  projectId: number,
): Effect.Effect<WorkflowRegistryContext, unknown> {
  return Effect.map(rt.deps.places.workspace.findProject(projectId), (project) => ({
    projectId,
    projectRoot: project?.rootPath ?? null,
  }));
}
