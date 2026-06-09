import { Layer } from 'effect';

import { GitLive } from './git/index.js';
import { DataDirectoryLive, RuntimeDatabaseLive, StateFileLive } from './persistence/index.js';
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
const SurfaceRepositoryLayer = SurfaceRepositoryLive.pipe(Layer.provide(DatabaseLive));
const SetupRepositoryLive = WorktreeSetupRepositoryLive.pipe(Layer.provide(DatabaseLive));
const SetupServiceLive = WorktreeSetupServiceLive.pipe(Layer.provide(SetupRepositoryLive));

export type RuntimeServices = WorkspaceServiceShape | SurfaceServiceShape;

export const RuntimeLayer = Layer.mergeAll(WorkspaceServiceLive, SurfaceServiceLive).pipe(
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
