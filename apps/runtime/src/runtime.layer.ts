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
import {
  CommandRepositoryLive,
  CommandService,
  CommandServiceLive,
  type CommandServiceShape,
} from './commands/index.js';
import { EventLoopWatchdogLive } from './diagnostics/event-loop-watchdog.js';
import { GitLive } from './git/index.js';
import { DataDirectoryLive, RuntimeDatabaseLive, StateFileLive } from './persistence/index.js';
import { StateFile } from './persistence/index.js';
import {
  NodePtyBackendLive,
  PtyBackendLive,
  PtyForegroundStateLive,
  PtyRepositoryLive,
  PtyServiceLive,
  TmuxBackendLive,
  type PtyServiceShape,
} from './pty-processes/index.js';
import { RuntimeConfigLive } from './runtime-config/index.js';
import {
  InternalRuntimeEventBus,
  InternalRuntimeEventBusLive,
  RuntimeEventBusLive,
  RuntimeEventProjectionLive,
  type InternalRuntimeEventBusService,
  type RuntimeEventBusService,
} from './runtime-events/index.js';
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
  WorkflowCapabilitiesLive,
  WorkflowEngineLive,
  WorkflowEventLedgerLive,
  WorkflowHeadlessLive,
  WorkflowRunProjectionLive,
  WorkflowRegistryLive,
  WorkflowRepositoryLive,
  type WorkflowEngineService,
  type WorkflowEventLedgerService,
  type WorkflowRunProjectionService,
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
const WorkflowRepositoryLayer = WorkflowRepositoryLive.pipe(Layer.provide(DatabaseLive));
const WorkflowEventLedgerLayer = WorkflowEventLedgerLive.pipe(
  Layer.provide(WorkflowRepositoryLayer),
  Layer.provide(DataDirectoryLive),
);
const PtyServiceLayer = PtyServiceLive.pipe(
  Layer.provide(PtyRepositoryLayer),
  Layer.provide(PtyBackendLive),
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
const WorkflowHeadlessLayer = WorkflowHeadlessLive.pipe(
  Layer.provide(HarnessAdapterRegistryLayer),
  Layer.provide(PtyServiceLayer),
);
const AgentSessionRepositoryLayer = AgentSessionRepositoryLive.pipe(
  Layer.provide(DatabaseLive),
  Layer.provide(AgentSessionArtifactsLayer),
);
const TerminalSessionRepositoryLayer = TerminalSessionRepositoryLive.pipe(
  Layer.provide(DatabaseLive),
);
const SessionLifecycleLayer = SessionLifecycleLive;
const AgentSessionServiceLayer = AgentSessionServiceLive.pipe(
  Layer.provide(AgentSessionRepositoryLayer),
  Layer.provide(PtyServiceLayer),
  Layer.provide(HarnessAdapterRegistryLayer),
  Layer.provide(SessionLifecycleLayer),
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
);
const SurfaceAndPtyServiceLayer = Layer.mergeAll(SurfaceServiceLayer, PtyServiceLayer);
const WorkflowCapabilitiesLayer = WorkflowCapabilitiesLive.pipe(
  Layer.provide(AgentSessionServiceLayer),
  Layer.provide(SurfaceServiceLayer),
  Layer.provide(PtyServiceLayer),
  Layer.provide(AgentSessionArtifactsLayer),
  Layer.provide(HarnessLedgerObserverLayer),
  Layer.provide(WorkflowHeadlessLayer),
  Layer.provide(WorkflowEventLedgerLayer),
);
const WorkflowEngineLayer = WorkflowEngineLive.pipe(
  Layer.provide(WorkflowRepositoryLayer),
  Layer.provide(WorkflowEventLedgerLayer),
  Layer.provide(WorkflowRegistryLive.pipe(Layer.provide(DataDirectoryLive))),
  Layer.provide(RepositoryLive),
  Layer.provide(SurfaceServiceLayer),
  Layer.provide(AgentSessionArtifactsLayer),
  Layer.provide(HarnessLedgerObserverLayer),
  Layer.provide(WorkflowHeadlessLayer),
  Layer.provide(WorkflowCapabilitiesLayer),
);
const WorkflowRunProjectionLayer = WorkflowRunProjectionLive.pipe(
  Layer.provide(WorkflowRepositoryLayer),
  Layer.provide(WorkflowEventLedgerLayer),
);
const SessionGcLayer = SessionGcLive.pipe(
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
  WorkflowRunProjectionLayer,
  WorkflowEventLedgerLayer,
  AgentSessionAttentionProjectionLayer,
  SessionLifecycleLayer,
  SessionGcLayer,
);
const CommandServiceLayer = CommandServiceLive.pipe(
  Layer.provide(CommandRepositoryLayer),
  Layer.provide(RepositoryLive),
  Layer.provide(PtyServiceLayer),
  Layer.provide(PtyRepositoryLayer),
  Layer.provide(DataDirectoryLive),
);
const WorkspaceServiceLayer = WorkspaceServiceLive.pipe(
  Layer.provide(SurfaceRepositoryLayer),
  Layer.provide(SurfaceAndPtyServiceLayer),
  Layer.provide(CommandServiceLayer),
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
  | WorkflowEventLedgerService
  | WorkflowRunProjectionService;

const ServicesLayer = Layer.mergeAll(
  WorkspaceServiceLayer,
  CommandServiceLayer,
  WorkflowEngineLayer,
  StartupActivationLayer,
  EventLoopWatchdogLive,
  ApiServicesLayer,
).pipe(Layer.provideMerge(InternalRuntimeEventBusLive), Layer.provideMerge(RuntimeEventBusLive));

export const RuntimeLayer = ServicesLayer.pipe(
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
