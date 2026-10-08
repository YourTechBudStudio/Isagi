import { Effect, Layer } from 'effect';

import {
  HarnessAdapterRegistryLive,
  HarnessLedgerObserverLive,
} from './agent-sessions/harness/index.js';
import {
  AgentSessionAttentionProjectionLive,
  AgentSessionArtifactsLive,
  AgentSessionRepositoryLive,
  AgentSessionServiceLive,
  type AgentSessionAttentionProjectionService,
  type AgentSessionServiceShape,
} from './agent-sessions/index.js';
import { CliAccessLive, type CliAccessService } from './cli-access/index.js';
import {
  CommandPortProbeLive,
  CommandRepositoryLive,
  CommandService,
  CommandServiceLive,
  type CommandServiceShape,
} from './commands/index.js';
import { EventLoopWatchdogLive } from './diagnostics/event-loop-watchdog.js';
import {
  EditorContextRepositoryLive,
  EditorContextServiceLive,
  type EditorContextServiceShape,
} from './editor-contexts/index.js';
import {
  EditorInstallIoLive,
  EditorProvisioningLive,
  type EditorProvisioningService,
} from './editor-provisioning/index.js';
import { GitLive } from './git/index.js';
import {
  HarnessControlPlaneLive,
  type HarnessControlPlaneService,
} from './harness-control-plane/index.js';
import {
  HostInventoryLive,
  type HostInventoryService,
  UserShellLive,
} from './host-inventory/index.js';
import { EntityLockLive } from './lib/locks/entity-lock.js';
import { LoopbackPortProbeLive } from './lib/net/loopback-port-probe.js';
import { DataDirectoryLive, RuntimeDatabaseLive, StateFileLive } from './persistence/index.js';
import { StateFile } from './persistence/index.js';
import {
  NodePtyBackendLive,
  PtyBackendCatalogLive,
  PtyForegroundStateLive,
  PtyRepositoryLive,
  PtyServiceLive,
  TmuxBackendLive,
  type PtyServiceShape,
} from './pty-processes/index.js';
import { RuntimeConfigLive, type RuntimeConfigService } from './runtime-config/index.js';
import {
  InternalRuntimeEventBus,
  InternalRuntimeEventBusLive,
  RuntimeEventBusLive,
  type InternalRuntimeEventBusService,
  type RuntimeEventBusService,
} from './runtime-events/index.js';
import { RuntimeEventProjectionLive } from './runtime-events/projection.service.js';
import { SessionGcLive, type SessionGcService } from './session-gc/index.js';
import { SessionLifecycleLive, type SessionLifecycleService } from './session-lifecycle/index.js';
import {
  SurfaceRepositoryLive,
  SurfaceServiceLive,
  type SurfaceRepositoryService,
  type SurfaceServiceShape,
} from './surfaces/index.js';
import {
  TerminalSessionRepositoryLive,
  TerminalSessionServiceLive,
  type TerminalSessionServiceShape,
} from './terminal-sessions/index.js';
import {
  WorkflowContentStoreLive,
  WorkflowEngineLive,
  WorkflowRegistryLive,
  WorkflowRunErasureLive,
  type WorkflowEngineService,
} from './workflows/index.js';
import {
  WorkspaceRepository,
  WorkspaceRepositoryLive,
  WorkspaceServiceLive,
  type WorkspaceServiceShape,
} from './workspace/index.js';
import { WorktreeSetupRepositoryLive, WorktreeSetupServiceLive } from './worktree-setup/index.js';

const DatabaseLive = RuntimeDatabaseLive.pipe(Layer.provide(DataDirectoryLive));
const StateLive = StateFileLive.pipe(Layer.provide(DataDirectoryLive));
const RuntimeConfigLayer = RuntimeConfigLive.pipe(Layer.provide(DataDirectoryLive));
const HostInventoryLayer = HostInventoryLive;
// Bound once, like the entity lock: the provisioning attempt, its semaphore, and
// the resolved installation are per-instance state, so the control plane and the
// API must observe the same service rather than two independently constructed
// ones.
const EditorProvisioningLayer = EditorProvisioningLive.pipe(
  Layer.provide(DataDirectoryLive),
  Layer.provide(EditorInstallIoLive),
);
const HarnessControlPlaneLayer = HarnessControlPlaneLive.pipe(
  Layer.provide(HostInventoryLayer),
  Layer.provide(RuntimeConfigLayer),
  Layer.provide(DataDirectoryLive),
  Layer.provide(EditorProvisioningLayer),
);
const RepositoryLive = WorkspaceRepositoryLive.pipe(Layer.provide(DatabaseLive));
const AgentSessionArtifactsLayer = AgentSessionArtifactsLive.pipe(Layer.provide(DataDirectoryLive));
const PtyForegroundStateLayer = PtyForegroundStateLive;
const HarnessLedgerObserverLayer = HarnessLedgerObserverLive.pipe(
  Layer.provide(AgentSessionArtifactsLayer),
  Layer.provide(DataDirectoryLive),
  Layer.provide(DatabaseLive),
);
const AgentSessionAttentionProjectionLayer = AgentSessionAttentionProjectionLive.pipe(
  Layer.provide(AgentSessionArtifactsLayer),
  Layer.provide(HarnessLedgerObserverLayer),
  Layer.provide(PtyForegroundStateLayer),
  Layer.provide(DatabaseLive),
);
const SurfaceRepositoryLayer = SurfaceRepositoryLive.pipe(
  Layer.provide(DatabaseLive),
  Layer.provide(AgentSessionArtifactsLayer),
  Layer.provide(AgentSessionAttentionProjectionLayer),
);
const SetupRepositoryLive = WorktreeSetupRepositoryLive.pipe(Layer.provide(DatabaseLive));
const SetupServiceLive = WorktreeSetupServiceLive.pipe(Layer.provide(SetupRepositoryLive));
const PtyRepositoryLayer = PtyRepositoryLive.pipe(Layer.provide(DatabaseLive));
const CommandRepositoryLayer = CommandRepositoryLive.pipe(Layer.provide(DatabaseLive));
const WorkflowRegistryLayer = WorkflowRegistryLive.pipe(
  Layer.provide(DataDirectoryLive),
  Layer.provide(RuntimeConfigLayer),
);
// One instance for the whole runtime: the server publishes the URL into the same service every PTY
// launch reads its environment from.
const CliAccessLayer = CliAccessLive.pipe(Layer.provide(DataDirectoryLive));
const PtyServiceLayer = PtyServiceLive.pipe(
  Layer.provide(CliAccessLayer),
  Layer.provide(PtyRepositoryLayer),
  Layer.provide(PtyBackendCatalogLive),
  Layer.provide(PtyForegroundStateLayer),
  Layer.provide(RuntimeConfigLayer),
  Layer.provide(NodePtyBackendLive),
  Layer.provide(TmuxBackendLive),
  Layer.provide(DataDirectoryLive),
);
const HarnessAdapterRegistryLayer = HarnessAdapterRegistryLive.pipe(
  Layer.provide(DataDirectoryLive),
  Layer.provide(AgentSessionArtifactsLayer),
);
const AgentSessionRepositoryLayer = AgentSessionRepositoryLive.pipe(
  Layer.provide(DatabaseLive),
  Layer.provide(AgentSessionArtifactsLayer),
);
const TerminalSessionRepositoryLayer = TerminalSessionRepositoryLive.pipe(
  Layer.provide(DatabaseLive),
);
// Bound once so every consumer below provides the same layer value, which is
// what makes "one lock scope" a fact rather than a convention.
const EntityLockLayer = EntityLockLive;
// Stateless, unlike the lock: sharing the reference is graph hygiene rather
// than a correctness property.
const LoopbackPortProbeLayer = LoopbackPortProbeLive;
const SessionLifecycleLayer = SessionLifecycleLive.pipe(Layer.provide(EntityLockLayer));
const EditorContextRepositoryLayer = EditorContextRepositoryLive.pipe(Layer.provide(DatabaseLive));
// Scoped: constructing it converges interrupted boot attempts, forks the single
// interpreter of editor PTY events, and takes ownership of the probe fibers. It
// is provided the same `EntityLockLayer` value as session lifecycle, which is
// what makes "one lock scope per worktree" true across both domains.
const EditorContextServiceLayer = EditorContextServiceLive.pipe(
  Layer.provide(EditorContextRepositoryLayer),
  Layer.provide(RepositoryLive),
  Layer.provide(PtyServiceLayer),
  Layer.provide(EditorProvisioningLayer),
  Layer.provide(LoopbackPortProbeLayer),
  Layer.provide(EntityLockLayer),
);
const AgentSessionServiceLayer = AgentSessionServiceLive.pipe(
  Layer.provide(AgentSessionRepositoryLayer),
  Layer.provide(PtyServiceLayer),
  Layer.provide(HarnessAdapterRegistryLayer),
  Layer.provide(SessionLifecycleLayer),
  Layer.provide(HarnessControlPlaneLayer),
);
const TerminalSessionServiceLayer = TerminalSessionServiceLive.pipe(
  Layer.provide(TerminalSessionRepositoryLayer),
  Layer.provide(PtyServiceLayer),
  Layer.provide(SessionLifecycleLayer),
);
const SessionServicesLayer = Layer.mergeAll(AgentSessionServiceLayer, TerminalSessionServiceLayer);
const SurfaceServiceLayer = SurfaceServiceLive.pipe(
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
const CommandServiceLayer = CommandServiceLive.pipe(
  Layer.provide(CommandRepositoryLayer),
  Layer.provide(RepositoryLive),
  Layer.provide(PtyServiceLayer),
  Layer.provide(PtyRepositoryLayer),
  Layer.provide(CommandPortProbeLive.pipe(Layer.provide(LoopbackPortProbeLayer))),
  Layer.provide(DataDirectoryLive),
);
// Project deletion erases the project's workflow runs inside its own transaction, through the
// workflows domain's stateless `WorkflowRunErasure`.
const WorkspaceServiceLayer = WorkspaceServiceLive.pipe(
  Layer.provide(SurfaceRepositoryLayer),
  Layer.provide(SurfaceAndPtyServiceLayer),
  Layer.provide(CommandServiceLayer),
  Layer.provide(WorkflowRunErasureLive),
);
// Bound once so exactly one content collector runs; the engine is its only consumer.
const WorkflowContentStoreLayer = WorkflowContentStoreLive.pipe(
  Layer.provide(DataDirectoryLive),
  Layer.provide(DatabaseLive),
);
// The engine owns every workflow write and pushes its events live, with one exception: project
// deletion erases a project's runs through `WorkflowRunErasure`. It creates worktrees and surfaces
// through their owning services (ADR 0008).
const WorkflowEngineLayer = WorkflowEngineLive.pipe(
  Layer.provide(DatabaseLive),
  Layer.provide(GitLive),
  Layer.provide(WorkflowContentStoreLayer),
  Layer.provide(WorkflowRegistryLayer),
  Layer.provide(RepositoryLive),
  Layer.provide(WorkspaceServiceLayer),
  Layer.provide(SurfaceServiceLayer),
  Layer.provide(SurfaceRepositoryLayer),
  Layer.provide(AgentSessionServiceLayer),
  Layer.provide(AgentSessionArtifactsLayer),
  Layer.provide(HarnessLedgerObserverLayer),
  Layer.provide(PtyServiceLayer),
  Layer.provide(HarnessAdapterRegistryLayer),
  Layer.provide(HarnessControlPlaneLayer),
);
const SessionGcLayer = SessionGcLive.pipe(
  Layer.provide(AgentSessionArtifactsLayer),
  Layer.provide(AgentSessionRepositoryLayer),
  Layer.provide(TerminalSessionRepositoryLayer),
  Layer.provide(SessionLifecycleLayer),
);
const EventProjectionLayer = RuntimeEventProjectionLive.pipe(
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
const StartupActivationLayer = Layer.scopedDiscard(
  Effect.gen(function* () {
    yield* CommandService;
    const stateFile = yield* StateFile;
    const repository = yield* WorkspaceRepository;
    const internalEvents = yield* InternalRuntimeEventBus;
    const state = yield* stateFile.read;
    const worktreeId = state.workspace.activeWorktreeId;
    if (worktreeId === null) return;
    const worktree = yield* repository.findWorktree(worktreeId);
    if (!worktree) return;
    yield* internalEvents.publish({
      type: 'worktree_activation_change',
      previousWorktreeId: null,
      nextWorktreeId: worktree.id,
      cause: 'startup_restored',
    });
  }),
).pipe(Layer.provide(CommandServiceLayer), Layer.provide(RepositoryLive), Layer.provide(StateLive));

export type RuntimeServices =
  | CommandServiceShape
  | WorkspaceServiceShape
  | SurfaceServiceShape
  | PtyServiceShape
  | AgentSessionServiceShape
  | AgentSessionAttentionProjectionService
  | TerminalSessionServiceShape
  | RuntimeEventBusService
  | InternalRuntimeEventBusService
  | SessionLifecycleService
  | SessionGcService
  | SurfaceRepositoryService
  | WorkflowEngineService
  | HostInventoryService
  | HarnessControlPlaneService
  | EditorProvisioningService
  | CliAccessService
  // `EntityLockService` is deliberately absent, and stays absent now that the
  // placement path uses it: it is a construction dependency of
  // `SessionLifecycle`, `EditorContextService`, and `SurfaceService`, each of
  // which resolves it once when its layer is built. No effect run through
  // `ManagedRuntime` requires the tag, so adding it here would widen the runtime
  // environment for a caller that does not exist.
  | EditorContextServiceShape
  | RuntimeConfigService;

const ServicesLayer = Layer.mergeAll(
  WorkspaceServiceLayer,
  CommandServiceLayer,
  WorkflowEngineLayer,
  StartupActivationLayer,
  EventLoopWatchdogLive,
  HostInventoryLayer,
  HarnessControlPlaneLayer,
  RuntimeConfigLayer,
  ApiServicesLayer,
).pipe(Layer.provideMerge(InternalRuntimeEventBusLive), Layer.provideMerge(RuntimeEventBusLive));

export const RuntimeLayer = ServicesLayer.pipe(
  Layer.provide(UserShellLive),
  Layer.provide(
    Layer.mergeAll(
      RepositoryLive,
      SetupRepositoryLive,
      SetupServiceLive,
      StateLive,
      GitLive,
      DataDirectoryLive,
    ),
  ),
);
