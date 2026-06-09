export { registerSurfacesApi } from './api.js';
export {
  SurfaceRepository,
  SurfaceRepositoryLive,
  duplicateSafeTitle,
} from './surfaces.repository.js';
export type { SurfaceRepositoryService } from './surfaces.repository.js';
export { SurfaceError, SurfaceService, SurfaceServiceLive } from './surfaces.service.js';
export type { SurfaceService as SurfaceServiceShape } from './surfaces.service.js';
export type {
  CreatePtySessionMetadataInput,
  CreateSinglePaneSurfaceInput,
  CreateSinglePaneSurfaceOutput,
  EnvironmentFocusRow,
  PtySessionRow,
  SurfaceMetadataRow,
  SurfacePaneRow,
  SurfaceRow,
} from './types.js';
