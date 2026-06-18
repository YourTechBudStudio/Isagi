import { Layer } from 'effect';

import {
  AgentSessionAttentionProjectionLive,
  AgentSessionArtifactsLive,
  AgentSessionRepositoryLive,
  AgentSessionServiceLive,
  type AgentSessionServiceShape,
} from './agent-sessions/index.js';
import { GitLive } from './git/index.js';
import { HarnessAdapterRegistryLive } from './harness-adapters/index.js';
import { DataDirectoryLive, RuntimeDatabaseLive, StateFileLive } from './persistence/index.js';
import {
  NodePtyBackendLive,
  PtyBackendLive,
  PtyRepositoryLive,
  PtyServiceLive,
  TmuxBackendLive,
  type PtyServiceShape,
} from './pty-processes/index.js';
import { RuntimeConfigLive } from './runtime-config/index.js';
import {
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
  type SurfaceServiceShape,
} from './surfaces/index.js';
import {
  TerminalSessionRepositoryLive,
  TerminalSessionServiceLive,
  type TerminalSessionServiceShape,
} from './terminal-sessions/index.js';
import {
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
const AgentSessionAttentionProjectionLayer = AgentSessionAttentionProjectionLive.pipe(
  Layer.provide(AgentSessionArtifactsLayer),
  Layer.provide(DataDirectoryLive),
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
const PtyServiceLayer = PtyServiceLive.pipe(
  Layer.provide(PtyRepositoryLayer),
  Layer.provide(PtyBackendLive),
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
  Layer.provide(SessionLifecycleLayer),
  Layer.provide(AgentSessionAttentionProjectionLayer),
);
const SurfaceAndPtyServiceLayer = Layer.mergeAll(SurfaceServiceLayer, PtyServiceLayer);
const SessionGcLayer = SessionGcLive.pipe(
  Layer.provide(AgentSessionRepositoryLayer),
  Layer.provide(TerminalSessionRepositoryLayer),
  Layer.provide(SessionLifecycleLayer),
);
const EventProjectionLayer = RuntimeEventProjectionLive.pipe(
  Layer.provide(AgentSessionRepositoryLayer),
  Layer.provide(TerminalSessionRepositoryLayer),
  Layer.provide(SurfaceRepositoryLayer),
);
const ApiServicesLayer = Layer.mergeAll(
  SurfaceAndPtyServiceLayer,
  SessionServicesLayer,
  EventProjectionLayer,
  SessionLifecycleLayer,
  SessionGcLayer,
);
const WorkspaceServiceLayer = WorkspaceServiceLive.pipe(
  Layer.provide(SurfaceRepositoryLayer),
  Layer.provide(SurfaceAndPtyServiceLayer),
);

export type RuntimeServices =
  | WorkspaceServiceShape
  | SurfaceServiceShape
  | PtyServiceShape
  | AgentSessionServiceShape
  | TerminalSessionServiceShape
  | RuntimeEventBusService
  | InternalRuntimeEventBusService
  | SessionLifecycleService
  | SessionGcService;

const ServicesLayer = Layer.mergeAll(WorkspaceServiceLayer, ApiServicesLayer).pipe(
  Layer.provideMerge(InternalRuntimeEventBusLive),
  Layer.provideMerge(RuntimeEventBusLive),
);

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
