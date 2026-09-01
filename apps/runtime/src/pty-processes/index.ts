export { registerPtyApi } from './api.js';
export { PtyBackendCatalog, PtyBackendCatalogLive } from './backend.js';
export type { PtyBackendCatalogService } from './backend.js';
export { PtyForegroundState, PtyForegroundStateLive } from './foreground-state.js';
export type { PtyForegroundStateService } from './foreground-state.js';
export { NodePtyBackend, NodePtyBackendLive } from './adapters/node-pty.js';
export { PtyRepository, PtyRepositoryLive } from './pty.repository.js';
export type { PtyRepositoryService } from './pty.repository.js';
export { PtyService, PtyServiceLive } from './pty.service.js';
export {
  activePtyProcessIds,
  activePtyProcessIdsForSessions,
  PtyTeardownError,
  terminatePtyProcessIds,
} from './session-teardown.js';
export { TmuxBackend, TmuxBackendLive } from './adapters/tmux.js';
export type { PtyService as PtyServiceShape } from './pty.service.js';
// The command domain names a durable termination reason when it asks for
// generic cleanup; it stays PTY-layer vocabulary, exported rather than
// re-spelled so the two cannot drift.
export type { DurablePtyTerminationReason } from './service/lifecycle.js';
export { exitDetail } from './exit-detail.js';
// The single `pty_processes` row decoder. Every domain that joins a process
// onto its own durable entity reads it through here (ADR 0005/0008).
export { ptyProcessRow } from './row-mapper.js';
export type {
  BackendAttachment,
  LaunchBackendSessionInput,
  PtyBackend as PtyBackendShape,
  PtyExit,
  PtyProcessAllocation,
  PtyProcessRecord,
  PtyProcessRow,
} from './types.js';
// The affirmative-vs-absent kill outcome, exported so a caller that must not
// clear ownership on an unconfirmed termination can name what it requires.
export type { PtyTerminateOutcome } from './service/termination.js';
export {
  PtyKillError,
  PtyResizeError,
  PtyServiceError,
  PtyStartError,
  PtyWriteError,
} from './types.js';
