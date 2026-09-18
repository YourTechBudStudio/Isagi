import {
  parseWorkflowBuildManifestJson,
  supportedWorkflowContractVersion,
  workflowBuildManifestVersion,
} from '@yourtechbudstudio/isagi-workflow-verifier/receipt';
import {
  hashDescriptor,
  workflowStructureDescriptorVersion,
  type WorkflowStructureDescriptor,
} from '@yourtechbudstudio/isagi-workflow-verifier/structure';
import { eq } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import { DatabaseError, RuntimeDatabase } from '../../persistence/index.js';
import { workflowArtifacts } from '../../persistence/schema.js';
import type { ContentUnavailable } from '../persistence/content-store.js';
import {
  WorkflowPayloadStore,
  type PayloadPublishError,
  type WorkflowPayloadStoreService,
} from '../persistence/payload-store.js';
import type { WorkflowArtifactRecord } from '../persistence/records.js';
import { artifactRecord } from '../persistence/row-mappers.js';
import { slotColumns } from '../persistence/slots.js';
import {
  loadPinnedWorkflowArtifact,
  validateAndPublishWorkflowPackage,
  WorkflowLoadError,
  type LoadedWorkflowArtifact,
  type WorkflowDefinitionCache,
} from './loader.js';

/**
 * The retained catalog of definition versions.
 *
 * Two jobs that look similar and are not. `publish`/`loadPinned` produce *executable* artifacts and
 * only ever run when a run actually has to execute something. `readDescriptor` serves structure as
 * **data**, from the retained row, and never imports anything — which is the whole reason the
 * descriptor is stored at all: the inspector has to describe a version that may no longer exist on
 * disk, may have been built by a different SDK, and must never be allowed to run.
 *
 * Publication is independent of adoption. A Retry whose structural validation then fails can leave
 * an unused catalog row behind; that is inert history, and it is strictly better than letting a run
 * adopt a pin that was never recorded.
 */
export interface WorkflowArtifactCatalogService {
  readonly publish: (input: {
    readonly workflowKey: string;
    readonly packageRoot: string;
  }) => Effect.Effect<
    LoadedWorkflowArtifact,
    WorkflowLoadError | DatabaseError | PayloadPublishError
  >;
  readonly loadPinned: (input: {
    readonly artifactHash: string;
    readonly workflowKey?: string | undefined;
  }) => Effect.Effect<LoadedWorkflowArtifact, WorkflowLoadError | DatabaseError>;
  /** Structure as data. Never imports executable code, so an old version is safe to inspect. */
  readonly readDescriptor: (
    artifactHash: string,
  ) => Effect.Effect<WorkflowStructureDescriptor | null, DatabaseError | ContentUnavailable>;
  readonly findRecord: (
    artifactHash: string,
  ) => Effect.Effect<WorkflowArtifactRecord | null, DatabaseError>;
}

export const WorkflowArtifactCatalog = Context.GenericTag<WorkflowArtifactCatalogService>(
  'isagi/WorkflowArtifactCatalog',
);

export interface WorkflowArtifactCatalogOptions {
  readonly cacheRoot: string;
  readonly definitionCache: WorkflowDefinitionCache;
}

export function makeWorkflowArtifactCatalog(
  database: Pick<import('../../persistence/index.js').RuntimeDatabaseService, 'use'>,
  payloads: WorkflowPayloadStoreService,
  options: WorkflowArtifactCatalogOptions,
): WorkflowArtifactCatalogService {
  const findRecord = (artifactHash: string) =>
    database.use('workflow_find_artifact', (db) => {
      const row = db
        .select()
        .from(workflowArtifacts)
        .where(eq(workflowArtifacts.artifactHash, artifactHash))
        .get();
      return row ? artifactRecord(row) : null;
    });

  return {
    findRecord,

    publish: (input) =>
      Effect.gen(function* () {
        const artifact = yield* validateAndPublishWorkflowPackage({
          workflowKey: input.workflowKey,
          packageRoot: input.packageRoot,
          cacheRoot: options.cacheRoot,
          definitionCache: options.definitionCache,
        });
        const manifest = yield* readManifest(input.packageRoot, input.workflowKey);
        // The descriptor goes through the ordinary payload boundary, so a large structure is a
        // reference and a small one is inline — the same rule every other recorded value follows.
        const descriptor = yield* payloads.publish(artifact.descriptor);
        const columns = slotColumns(descriptor);
        yield* database.use('workflow_upsert_artifact', (db) => {
          db.insert(workflowArtifacts)
            .values({
              artifactHash: artifact.artifactHash,
              workflowKey: input.workflowKey,
              contractVersion: manifest.workflowContractVersion,
              manifestVersion: manifest.manifestVersion,
              descriptorVersion: workflowStructureDescriptorVersion,
              sdkVersion: manifest.sdk.version,
              verifierVersion: manifest.verifier.version,
              sourceHash: manifest.source.sha256,
              structureHash: hashDescriptor(artifact.descriptor),
              rootGraphKey: artifact.descriptor.rootGraphKey,
              descriptorInline: columns.inline,
              descriptorRef: columns.ref,
              firstSeenAt: new Date().toISOString(),
            })
            // Content-addressed, so re-publishing the same bytes is the same row. `first_seen_at`
            // means first seen, and re-verifying an existing artifact does not rewrite history.
            .onConflictDoNothing({ target: workflowArtifacts.artifactHash })
            .run();
        });
        return artifact;
      }),

    loadPinned: (input) =>
      loadPinnedWorkflowArtifact({
        artifactHash: input.artifactHash,
        cacheRoot: options.cacheRoot,
        workflowKey: input.workflowKey,
        definitionCache: options.definitionCache,
      }),

    readDescriptor: (artifactHash) =>
      Effect.gen(function* () {
        const record = yield* findRecord(artifactHash);
        if (!record?.descriptor) return null;
        const value = yield* payloads.resolve(record.descriptor);
        return value as WorkflowStructureDescriptor;
      }),
  } satisfies WorkflowArtifactCatalogService;
}

function readManifest(packageRoot: string, workflowKey: string) {
  return Effect.tryPromise({
    try: async () => {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const text = await readFile(join(packageRoot, 'dist', 'isagi-workflow-build.json'), 'utf8');
      const manifest = parseWorkflowBuildManifestJson(text);
      if (
        manifest.manifestVersion !== workflowBuildManifestVersion ||
        manifest.workflowContractVersion !== supportedWorkflowContractVersion
      ) {
        throw new Error('Unsupported workflow build manifest.');
      }
      return manifest;
    },
    catch: (cause) =>
      new WorkflowLoadError({
        reason: 'invalid_manifest',
        message: 'Could not read the workflow build manifest for the artifact catalog.',
        workflowKey,
        cause,
      }),
  });
}

export const WorkflowArtifactCatalogLive = (options: WorkflowArtifactCatalogOptions) =>
  Layer.effect(
    WorkflowArtifactCatalog,
    Effect.gen(function* () {
      const database = yield* RuntimeDatabase;
      const payloads = yield* WorkflowPayloadStore;
      return makeWorkflowArtifactCatalog(database, payloads, options);
    }),
  );
