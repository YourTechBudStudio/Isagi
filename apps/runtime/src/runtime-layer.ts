import { Layer } from 'effect';

import { GitLive } from './git/index.js';
import { DataDirectoryLive, RuntimeDatabaseLive, StateFileLive } from './persistence/index.js';
import {
  WorkspaceRepositoryLive,
  WorkspaceServiceLive,
  type WorkspaceServiceShape,
} from './workspace/index.js';

const DatabaseLive = RuntimeDatabaseLive.pipe(Layer.provide(DataDirectoryLive));
const StateLive = StateFileLive.pipe(Layer.provide(DataDirectoryLive));
const RepositoryLive = WorkspaceRepositoryLive.pipe(Layer.provide(DatabaseLive));

export type RuntimeServices = WorkspaceServiceShape;

export const RuntimeLayer = WorkspaceServiceLive.pipe(
  Layer.provide(Layer.mergeAll(RepositoryLive, StateLive, GitLive, DataDirectoryLive)),
);
