export { registerEnvironmentRoutes } from './api.js';
export { SurfaceError, SurfaceOrderError } from './surfaces/errors.js';
export {
  SurfaceService, // Re-exported so launch-time placement validation refuses a title by the same rule that creation
  // and rename apply, rather than carrying a second copy of it.
  validateSurfaceTitle,
} from './surfaces/service.js';
export {
  insertPaneIntoLayout,
  layoutContainsPane,
  prunePaneFromLayout,
} from './surfaces/layout.js';
export type {
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
} from './surfaces/types.js';
export type { AgentSessionRow, PaneSessionBinding, TerminalSessionRow } from './sessions/types.js';
// The harness observer's `HarnessObservationTargets` port, implemented over agent sessions. Only the
// composition root wires it.
export { HarnessObservationTargetsLayer } from './agent-sessions/observation-targets.js';
export { AgentSessionAttentionProjection } from './agent-sessions/attention.js';
export { AgentSessionService } from './agent-sessions/service.js';
export { EnvironmentLayer } from './layer.js';
