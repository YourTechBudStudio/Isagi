import { Effect, Layer } from 'effect';

import { CliAccess } from '../cli-access/index.js';
import { CommandRepository, CommandService } from '../commands/index.js';
import {
  EditorContextRepository,
  EditorContextService,
  EditorInstallIo,
  EditorProvisioning,
} from '../editor/index.js';
import {
  AgentSessionAttentionProjection,
  AgentSessionRepository,
  AgentSessionService,
  HarnessObservationTargetsLayer,
  SurfaceRepository,
  SurfaceService,
  RuntimeEventProjection,
  TerminalSessionRepository,
  TerminalSessionService,
  SessionGc,
  SessionLifecycle,
} from '../environment/index.js';
import {
  AgentSessionArtifacts,
  HarnessControlPlane,
  HarnessAdapterRegistry,
  HarnessLedgerObserver,
  HostInventory,
} from '../harnesses/index.js';
import { EventLoopWatchdog } from '../platform/diagnostics/index.js';
import { InternalRuntimeEventBus, RuntimeEventBus } from '../platform/events/index.js';
import { Git } from '../platform/git/index.js';
import { EntityLock } from '../platform/locks/index.js';
import { LoopbackPortProbe } from '../platform/net/index.js';
import { DataDirectory, RuntimeDatabase } from '../platform/persistence/index.js';
import { UserShell } from '../platform/process/index.js';
import { ProjectRepository } from '../projects/index.js';
import {
  NodePtyBackend,
  PtyBackendCatalog,
  PtyForegroundState,
  PtyRepository,
  PtyService,
  TmuxBackend,
} from '../pty-processes/index.js';
import { RuntimeConfig } from '../runtime-config/index.js';
import {
  WorkflowContentStore,
  WorkflowEngine,
  WorkflowRegistry,
  WorkflowProjectErasure,
} from '../workflows/index.js';
import {
  StateFile,
  WorkspaceService,
  WorktreeDeleteDiagnosticsReader,
  WorktreeSetupRepository,
  WorktreeSetupService,
} from '../workspace/index.js';

const DatabaseLayer = RuntimeDatabase.layer.pipe(Layer.provide(DataDirectory.layer));
const StateFileLayer = StateFile.layer.pipe(Layer.provide(DataDirectory.layer));
const RuntimeConfigLayer = RuntimeConfig.layer.pipe(Layer.provide(DataDirectory.layer));
const HostInventoryLayer = HostInventory.layer;
// Bound once, like the entity lock: the provisioning attempt, its semaphore, and
// the resolved installation are per-instance state, so the control plane and the
// API must observe the same service rather than two independently constructed
// ones.
const EditorProvisioningLayer = EditorProvisioning.layer.pipe(
  Layer.provide(DataDirectory.layer),
  Layer.provide(EditorInstallIo.layer),
);
const HarnessControlPlaneLayer = HarnessControlPlane.layer.pipe(
  Layer.provide(HostInventoryLayer),
  Layer.provide(RuntimeConfigLayer),
  Layer.provide(DataDirectory.layer),
  Layer.provide(EditorProvisioningLayer),
);
const ProjectRepositoryLayer = ProjectRepository.layer.pipe(Layer.provide(DatabaseLayer));
const AgentSessionArtifactsLayer = AgentSessionArtifacts.layer.pipe(
  Layer.provide(DataDirectory.layer),
);
const PtyForegroundStateLayer = PtyForegroundState.layer;
// The observer's `HarnessObservationTargets` port, answered by the environment's agent sessions.
const HarnessObservationTargetsPort = HarnessObservationTargetsLayer.pipe(
  Layer.provide(DatabaseLayer),
);
const HarnessLedgerObserverLayer = HarnessLedgerObserver.layer.pipe(
  Layer.provide(AgentSessionArtifactsLayer),
  Layer.provide(DataDirectory.layer),
  Layer.provide(HarnessObservationTargetsPort),
);
const AgentSessionAttentionProjectionLayer = AgentSessionAttentionProjection.layer.pipe(
  Layer.provide(AgentSessionArtifactsLayer),
  Layer.provide(HarnessLedgerObserverLayer),
  Layer.provide(PtyForegroundStateLayer),
  Layer.provide(DatabaseLayer),
);
const SurfaceRepositoryLayer = SurfaceRepository.layer.pipe(
  Layer.provide(DatabaseLayer),
  Layer.provide(AgentSessionArtifactsLayer),
  Layer.provide(AgentSessionAttentionProjectionLayer),
);
const WorktreeSetupRepositoryLayer = WorktreeSetupRepository.layer.pipe(
  Layer.provide(DatabaseLayer),
);
const WorktreeSetupServiceLayer = WorktreeSetupService.layer.pipe(
  Layer.provide(WorktreeSetupRepositoryLayer),
);
const PtyRepositoryLayer = PtyRepository.layer.pipe(Layer.provide(DatabaseLayer));
const CommandRepositoryLayer = CommandRepository.layer.pipe(Layer.provide(DatabaseLayer));
const WorkflowRegistryLayer = WorkflowRegistry.layer.pipe(
  Layer.provide(DataDirectory.layer),
  Layer.provide(RuntimeConfigLayer),
);
// One instance for the whole runtime: the server publishes the URL into the same service every PTY
// launch reads its environment from.
const CliAccessLayer = CliAccess.layer.pipe(Layer.provide(DataDirectory.layer));
const PtyServiceLayer = PtyService.layer.pipe(
  Layer.provide(CliAccessLayer),
  Layer.provide(PtyRepositoryLayer),
  Layer.provide(PtyBackendCatalog.layer),
  Layer.provide(PtyForegroundStateLayer),
  Layer.provide(RuntimeConfigLayer),
  Layer.provide(NodePtyBackend.layer),
  Layer.provide(TmuxBackend.layer),
  Layer.provide(DataDirectory.layer),
);
const HarnessAdapterRegistryLayer = HarnessAdapterRegistry.layer.pipe(
  Layer.provide(DataDirectory.layer),
  Layer.provide(AgentSessionArtifactsLayer),
);
const AgentSessionRepositoryLayer = AgentSessionRepository.layer.pipe(
  Layer.provide(DatabaseLayer),
  Layer.provide(AgentSessionArtifactsLayer),
);
const TerminalSessionRepositoryLayer = TerminalSessionRepository.layer.pipe(
  Layer.provide(DatabaseLayer),
);
// Bound once so every consumer below provides the same layer value, which is
// what makes "one lock scope" a fact rather than a convention.
const EntityLockLayer = EntityLock.layer;
// Stateless, unlike the lock: sharing the reference is graph hygiene rather
// than a correctness property.
const LoopbackPortProbeLayer = LoopbackPortProbe.layer;
const SessionLifecycleLayer = SessionLifecycle.layer.pipe(Layer.provide(EntityLockLayer));
const EditorContextRepositoryLayer = EditorContextRepository.layer.pipe(
  Layer.provide(DatabaseLayer),
);
// Scoped: constructing it converges interrupted boot attempts, forks the single
// interpreter of editor PTY events, and takes ownership of the probe fibers. It
// is provided the same `EntityLockLayer` value as session lifecycle, which is
// what makes "one lock scope per worktree" true across both domains.
const EditorContextServiceLayer = EditorContextService.layer.pipe(
  Layer.provide(EditorContextRepositoryLayer),
  Layer.provide(ProjectRepositoryLayer),
  Layer.provide(PtyServiceLayer),
  Layer.provide(EditorProvisioningLayer),
  Layer.provide(LoopbackPortProbeLayer),
  Layer.provide(EntityLockLayer),
);
const AgentSessionServiceLayer = AgentSessionService.layer.pipe(
  Layer.provide(AgentSessionRepositoryLayer),
  Layer.provide(PtyServiceLayer),
  Layer.provide(HarnessAdapterRegistryLayer),
  Layer.provide(SessionLifecycleLayer),
  Layer.provide(HarnessControlPlaneLayer),
);
const TerminalSessionServiceLayer = TerminalSessionService.layer.pipe(
  Layer.provide(TerminalSessionRepositoryLayer),
  Layer.provide(PtyServiceLayer),
  Layer.provide(SessionLifecycleLayer),
);
const SessionServicesLayer = Layer.mergeAll(AgentSessionServiceLayer, TerminalSessionServiceLayer);
const SurfaceServiceLayer = SurfaceService.layer.pipe(
  Layer.provide(SurfaceRepositoryLayer),
  Layer.provide(AgentSessionServiceLayer),
  Layer.provide(TerminalSessionServiceLayer),
  Layer.provide(PtyServiceLayer),
  Layer.provide(SessionLifecycleLayer),
  Layer.provide(AgentSessionAttentionProjectionLayer),
  Layer.provide(EditorContextServiceLayer),
  // The same `EntityLockLayer` value session lifecycle and the editor service
  // are built on, so placement and the editor's own lifecycle serialize against
  // each other rather than against two separate maps.
  Layer.provide(EntityLockLayer),
);
const SurfaceAndPtyServiceLayer = Layer.mergeAll(SurfaceServiceLayer, PtyServiceLayer);
const CommandServiceLayer = CommandService.layer.pipe(
  Layer.provide(CommandRepositoryLayer),
  Layer.provide(ProjectRepositoryLayer),
  Layer.provide(PtyServiceLayer),
  Layer.provide(LoopbackPortProbeLayer),
  Layer.provide(DataDirectory.layer),
);
// Project deletion erases the project's workflow runs inside its own transaction, through the
// `ProjectDeletionParticipant` port the workflows domain implements (`WorkflowProjectErasure`).
const WorkspaceServiceLayer = WorkspaceService.layer.pipe(
  Layer.provide(WorktreeDeleteDiagnosticsReader.layer.pipe(Layer.provide(DatabaseLayer))),
  Layer.provide(SurfaceAndPtyServiceLayer),
  Layer.provide(CommandServiceLayer),
  Layer.provide(WorkflowProjectErasure),
);
// Bound once so exactly one content collector runs; the engine is its only consumer.
const WorkflowContentStoreLayer = WorkflowContentStore.layer.pipe(
  Layer.provide(DataDirectory.layer),
  Layer.provide(DatabaseLayer),
);
// The engine owns every workflow write and pushes its events live, with one exception: project
// deletion erases a project's runs through `WorkflowProjectErasure`. It creates worktrees and surfaces
// through their owning services (ADR 0008).
const WorkflowEngineLayer = WorkflowEngine.layer.pipe(
  Layer.provide(DatabaseLayer),
  Layer.provide(Git.layer),
  Layer.provide(WorkflowContentStoreLayer),
  Layer.provide(WorkflowRegistryLayer),
  Layer.provide(ProjectRepositoryLayer),
  Layer.provide(WorkspaceServiceLayer),
  Layer.provide(SurfaceServiceLayer),
  Layer.provide(AgentSessionServiceLayer),
  Layer.provide(AgentSessionArtifactsLayer),
  Layer.provide(HarnessLedgerObserverLayer),
  Layer.provide(PtyServiceLayer),
  Layer.provide(HarnessAdapterRegistryLayer),
  Layer.provide(HarnessControlPlaneLayer),
);
const SessionGcLayer = SessionGc.layer.pipe(
  Layer.provide(AgentSessionArtifactsLayer),
  Layer.provide(AgentSessionRepositoryLayer),
  Layer.provide(TerminalSessionRepositoryLayer),
  Layer.provide(SessionLifecycleLayer),
);
const EventProjectionLayer = RuntimeEventProjection.layer.pipe(
  Layer.provide(AgentSessionRepositoryLayer),
  Layer.provide(TerminalSessionRepositoryLayer),
  Layer.provide(SurfaceRepositoryLayer),
  Layer.provide(AgentSessionAttentionProjectionLayer),
);
const ApiServicesLayer = Layer.mergeAll(
  SurfaceRepositoryLayer,
  SurfaceAndPtyServiceLayer,
  SessionServicesLayer,
  EventProjectionLayer,
  AgentSessionAttentionProjectionLayer,
  SessionLifecycleLayer,
  SessionGcLayer,
  EditorProvisioningLayer,
  EditorContextServiceLayer,
  CliAccessLayer,
);
// The command service is built first so its activation subscriber hears the restored activation.
const StartupActivationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* CommandService;
    const workspace = yield* WorkspaceService;
    yield* workspace.publishRestoredActivation;
  }),
).pipe(Layer.provide(CommandServiceLayer), Layer.provide(WorkspaceServiceLayer));

export type RuntimeServices =
  | CommandService
  | WorkspaceService
  | SurfaceService
  | PtyService
  | AgentSessionService
  | AgentSessionAttentionProjection
  | TerminalSessionService
  | RuntimeEventBus
  | InternalRuntimeEventBus
  | SessionLifecycle
  | SessionGc
  | SurfaceRepository
  | WorkflowEngine
  | HostInventory
  | HarnessControlPlane
  | EditorProvisioning
  | CliAccess
  // `EntityLock` is deliberately absent, and stays absent now that the
  // placement path uses it: it is a construction dependency of
  // `SessionLifecycle`, `EditorContextService`, and `SurfaceService`, each of
  // which resolves it once when its layer is built. No effect run through
  // `ManagedRuntime` requires the tag, so adding it here would widen the runtime
  // environment for a caller that does not exist.
  | EditorContextService
  | RuntimeConfig;

const ServicesLayer = Layer.mergeAll(
  WorkspaceServiceLayer,
  CommandServiceLayer,
  WorkflowEngineLayer,
  StartupActivationLayer,
  EventLoopWatchdog.layer,
  HostInventoryLayer,
  HarnessControlPlaneLayer,
  RuntimeConfigLayer,
  ApiServicesLayer,
).pipe(
  Layer.provideMerge(InternalRuntimeEventBus.layer),
  Layer.provideMerge(RuntimeEventBus.layer),
);

export const RuntimeLayer = ServicesLayer.pipe(
  Layer.provide(UserShell.layer),
  Layer.provide(
    Layer.mergeAll(
      ProjectRepositoryLayer,
      WorktreeSetupRepositoryLayer,
      WorktreeSetupServiceLayer,
      StateFileLayer,
      Git.layer,
      DataDirectory.layer,
    ),
  ),
);
