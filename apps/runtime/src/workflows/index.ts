/**
 * The workflows module's public surface.
 *
 * Narrow on purpose: everything below is a foundation other runtime code composes — durable
 * records, the payload boundary, the artifact catalog and saved-position validation. The engine,
 * capability adapters, wait resolver, read projection and HTTP routes are internal to this module
 * and reach their consumers through the runtime layer, not through this barrel.
 *
 * The v1 exports that used to live here — the run-tree repository, the JSONL event ledger, the
 * `step` interpreter and its context — are gone with the contract they belonged to. Their modules
 * are still on disk and still red; phases 03–05 replace them.
 */

export {
  WorkflowPayloadStore,
  WorkflowPayloadStoreLive,
  inlinePayloadThresholdBytes,
  makeWorkflowPayloadStore,
  PayloadPublishError,
  PayloadUnavailable,
  workflowPayloadMediaType,
  type PayloadSlot,
  type WorkflowPayloadStoreService,
} from './persistence/payload-store.js';

export {
  WorkflowRunsRepository,
  WorkflowRunsRepositoryLive,
  makeWorkflowRunsRepository,
  type SegmentIdentity,
  type WorkflowRunsRepositoryService,
} from './persistence/runs.repository.js';

export {
  WorkflowOperationsRepository,
  WorkflowOperationsRepositoryLive,
  makeWorkflowOperationsRepository,
  type WorkflowOperationsRepositoryService,
} from './persistence/operations.repository.js';

export {
  WorkflowHistoryRepository,
  WorkflowHistoryRepositoryLive,
  appendTransitions,
  type TransitionDraft,
  type WorkflowHistoryPage,
  type WorkflowHistoryRepositoryService,
} from './persistence/history.repository.js';

export type {
  SegmentCommitOutcome,
  WorkflowWriteRejection,
  WorkflowWriteResult,
} from './persistence/outcomes.js';

export type {
  WorkflowArtifactRecord,
  WorkflowAttemptRecord,
  WorkflowExecutionRecord,
  WorkflowFrameRecord,
  WorkflowOperationRecord,
  WorkflowPauseIntervalRecord,
  WorkflowRunAttachmentRecord,
  WorkflowRunRecord,
  WorkflowTransitionRecord,
  WorkflowVersionAdoptionRecord,
  WorkflowWaitRecord,
} from './persistence/records.js';

export {
  WorkflowArtifactCatalog,
  WorkflowArtifactCatalogLive,
  makeWorkflowArtifactCatalog,
  type WorkflowArtifactCatalogOptions,
  type WorkflowArtifactCatalogService,
} from './structure/artifact-catalog.js';

export { validateSavedPositions, type SavedPositionInput } from './structure/retry-validation.js';

export {
  WorkflowLoadError,
  type LoadedWorkflowArtifact,
  type WorkflowDefinitionCache,
} from './structure/loader.js';

export {
  createWorkflowRegistry,
  WorkflowRegistry,
  WorkflowRegistryLive,
  type WorkflowRegistryService,
} from './structure/registry.js';

export {
  assertSerializable,
  canonicalBytes,
  canonicalJson,
  UnserializableValueError,
} from './state/serializable.js';

export { WorkflowEngineError, type WorkflowEngineServiceError } from './types.js';
