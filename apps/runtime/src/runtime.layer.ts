import { Layer } from 'effect';

import { GitLive } from './git/index.js';
import { DataDirectoryLive, RuntimeDatabaseLive, StateFileLive } from './persistence/index.js';
import {
  NodePtyBackendLive,
  PtyBackendLive,
  PtyRepositoryLive,
  PtyServiceLive,
  TmuxBackendLive,
  type PtyServiceShape,
} from './pty/index.js';
import { RuntimeEventBusLive, type RuntimeEventBusService } from './runtime-events/index.js';
import {
  SurfaceRepositoryLive,
  SurfaceServiceLive,
  type SurfaceServiceShape,
} from './surfaces/index.js';
import {
  WorkspaceRepositoryLive,
  WorkspaceServiceLive,
  type WorkspaceServiceShape,
} from './workspace/index.js';
import { WorktreeSetupRepositoryLive, WorktreeSetupServiceLive } from './worktree-setup/index.js';

const DatabaseLive = RuntimeDatabaseLive.pipe(Layer.provide(DataDirectoryLive));
const StateLive = StateFileLive.pipe(Layer.provide(DataDirectoryLive));
const RepositoryLive = WorkspaceRepositoryLive.pipe(Layer.provide(DatabaseLive));
const SurfaceRepositoryLayer = SurfaceRepositoryLive.pipe(
  Layer.provide(DatabaseLive),
  Layer.provide(DataDirectoryLive),
);
const SetupRepositoryLive = WorktreeSetupRepositoryLive.pipe(Layer.provide(DatabaseLive));
const SetupServiceLive = WorktreeSetupServiceLive.pipe(Layer.provide(SetupRepositoryLive));
const PtyRepositoryLayer = PtyRepositoryLive.pipe(
  Layer.provide(DatabaseLive),
  Layer.provide(SurfaceRepositoryLayer),
);
const PtyServiceLayer = PtyServiceLive.pipe(
  Layer.provide(PtyRepositoryLayer),
  Layer.provide(PtyBackendLive),
  Layer.provide(NodePtyBackendLive),
  Layer.provide(TmuxBackendLive),
  Layer.provide(DataDirectoryLive),
);
const PtyServiceWithEventsLayer = Layer.provideMerge(PtyServiceLayer, RuntimeEventBusLive);
const SurfaceAndPtyServiceLayer = Layer.provideMerge(SurfaceServiceLive, PtyServiceWithEventsLayer);
const WorkspaceServiceLayer = WorkspaceServiceLive.pipe(Layer.provide(SurfaceAndPtyServiceLayer));

export type RuntimeServices =
  | WorkspaceServiceShape
  | SurfaceServiceShape
  | PtyServiceShape
  | RuntimeEventBusService;

export const RuntimeLayer = Layer.mergeAll(WorkspaceServiceLayer, SurfaceAndPtyServiceLayer).pipe(
  Layer.provide(
    Layer.mergeAll(
      RepositoryLive,
      SurfaceRepositoryLayer,
      SetupRepositoryLive,
      SetupServiceLive,
      StateLive,
      GitLive,
      DataDirectoryLive,
    ),
  ),
);
