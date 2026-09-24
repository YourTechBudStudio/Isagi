export { registerSurfacesApi } from './api.js';
export {
  SurfaceRepository,
  SurfaceRepositoryLive,
  SurfaceRepositoryInitialSessionRejected,
  SurfaceRepositoryWorktreeMissing,
  duplicateSafeTitle,
} from './surfaces.repository.js';
export type {
  CreateSinglePaneSurfaceResult,
  KeyedSurfaceCreation,
  InitialSessionRejectionReason,
  SurfaceOrderMoveResult,
  SurfaceRepositoryService,
} from './surfaces.repository.js';
export { SurfaceError, SurfaceOrderError } from './errors.js';
export {
  SurfaceService,
  SurfaceServiceLive,
  // Re-exported so launch-time placement validation refuses a title by the same rule that creation
  // and rename apply, rather than carrying a second copy of it.
  validateSurfaceTitle,
} from './surfaces.service.js';
export type { SurfaceService as SurfaceServiceShape } from './surfaces.service.js';
export { insertPaneIntoLayout, layoutContainsPane, prunePaneFromLayout } from './layout.js';
export type {
  AgentSessionRow,
  CreateSinglePaneSurfaceInput,
  CreateSinglePaneSurfaceOutput,
  DeleteSurfaceRowsOutput,
  EnvironmentFocusRow,
  RenameSurfaceOutput,
  SurfaceDeletePaneTarget,
  SurfaceDeleteTarget,
  SurfaceMetadataRow,
  SurfacePaneRow,
  SurfaceRow,
  SplitSurfacePaneInput,
  SplitSurfacePaneOutput,
  TerminalSessionRow,
} from './types.js';
