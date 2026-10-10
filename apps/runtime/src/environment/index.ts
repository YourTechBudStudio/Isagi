export { registerSurfacesApi } from './surfaces/api.js';
// The durable session attach WebSockets (agent and terminal sessions), over the generic PTY stream.
export { registerPtyApi } from './sessions/attach-route.js';
export {
  SurfaceRepository,
  SurfaceRepositoryInitialSessionRejected,
  SurfaceRepositoryWorktreeMissing,
  duplicateSafeTitle,
} from './surfaces/repository.js';
export type {
  InitialSessionRejectionReason,
  SurfaceOrderMoveResult,
} from './surfaces/repository.js';
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
export { registerAgentSessionsApi } from './agent-sessions/api.js';
export { AgentSessionAttentionProjection } from './agent-sessions/attention.js';
export { AgentSessionService } from './agent-sessions/service.js';
export { RuntimeEventProjection } from './runtime-event-projection.js';
export { SessionGc } from './sessions/gc.js';

// Composition-root wiring only: `app/layer.ts` still provides these by hand until the services wire
// their own module dependencies (S3.7). No other module imports them.
export { AgentSessionRepository } from './agent-sessions/repository.js';
export { SessionLifecycle } from './sessions/lifecycle.js';
export { TerminalSessionRepository } from './terminal-sessions/repository.js';
export { TerminalSessionService } from './terminal-sessions/service.js';
