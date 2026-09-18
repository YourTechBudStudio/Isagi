/**
 * The workflows module's public surface.
 *
 * Narrow on purpose. Two kinds of thing are exported: the durable foundations other runtime code
 * composes — records, the payload boundary, the artifact catalog, saved-position validation — and
 * the one operational entry point, `WorkflowEngine`. The segment handlers, the wait resolver, the
 * environment watch, the operation service and the HTTP routes are internal, and nothing reaches
 * them except through a run id.
 *
 * The v1 exports that used to live here are gone with the contract they belonged to: the run-tree
 * repository, the JSONL event ledger, the `step` interpreter and its context, and the capability,
 * headless and resume-path modules. Their replacements — the durable read model, its delta
 * publisher and the HTTP routes — are the read surface below.
 */

export {
  WorkflowEngine,
  WorkflowEngineLive,
  type EngineFailure,
  type WorkflowEngineService,
} from './engine/interpreter.service.js';

export { registerWorkflowApi } from './api.js';

export {
  WorkflowRunProjection,
  WorkflowRunProjectionLive,
  makeWorkflowRunProjection,
  type ReadFailure,
  type WorkflowRunProjectionService,
} from './read/projection.service.js';

export {
  WorkflowDeltaPublisher,
  WorkflowDeltaPublisherLive,
  type WorkflowDeltaPublisherService,
} from './read/publisher.js';

export {
  WorkflowWriteWake,
  WorkflowWriteWakeLive,
  silentWriteWake,
  type WorkflowWriteWakeService,
} from './persistence/write-wake.js';

export type { ControlResult } from './engine/controls.js';
export type { DrainSummary } from './engine/dispatcher.js';
export type { DescriptorListing } from './engine/launch.js';

export {
  WorkflowOperationService,
  WorkflowOperationServiceLive,
  type WorkflowOperationServiceShape,
} from './operations/operation.service.js';

export {
  makeWorkflowEvidenceRepository,
  WorkflowEvidenceRepository,
  WorkflowEvidenceRepositoryLive,
  type CommitCaptureInput,
  type WorkflowEvidenceRepositoryService,
} from './evidence/evidence.repository.js';

export {
  ContentPublishError,
  ContentUnavailable,
  makeWorkflowContentStore,
  WorkflowContentStore,
  WorkflowContentStoreLive,
  type WorkflowContentStoreService,
} from './persistence/content-store.js';

export {
  WorkflowPayloadStore,
  WorkflowPayloadStoreLive,
  inlinePayloadThresholdBytes,
  makeWorkflowPayloadStore,
  PayloadPublishError,
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
