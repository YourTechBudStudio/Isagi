export { registerSurfacesApi } from './api.js';
export {
  SurfaceRepository,
  SurfaceRepositoryLive,
  SurfaceRepositoryWorktreeMissing,
  duplicateSafeTitle,
} from './surfaces.repository.js';
export type { SurfaceRepositoryService } from './surfaces.repository.js';
export { SurfaceError, SurfaceService, SurfaceServiceLive } from './surfaces.service.js';
export type { SurfaceService as SurfaceServiceShape } from './surfaces.service.js';
export { prunePaneFromLayout } from './layout.js';
export type {
  AgentSessionRow,
  CreateSinglePaneSurfaceInput,
  CreateSinglePaneSurfaceOutput,
  DeleteSurfaceRowsOutput,
  EnvironmentFocusRow,
  PtyProcessRow,
  PtySessionRow,
  RenameSurfaceOutput,
  SurfaceDeletePaneTarget,
  SurfaceDeleteSessionTarget,
  SurfaceDeleteTarget,
  SurfaceMetadataRow,
  SurfacePaneRow,
  SurfaceRow,
  TerminalSessionRow,
  WorktreeDeleteCleanupOutput,
} from './types.js';
