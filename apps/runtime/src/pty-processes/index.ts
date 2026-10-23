export { PtyForegroundState } from './foreground-state.js';
export { LaunchEnvironment } from './launch-environment.js';
export { PtyService } from './service.js';
export { PtyProcessesLayer } from './layer.js';
export type { PtyAttachmentPlan, PtyLaunchError } from './service.js';
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
  LaunchPtyProcessInput,
} from './types.js';
// The affirmative-vs-absent kill outcome, exported so a caller that must not
// clear ownership on an unconfirmed termination can name what it requires.
export type { PtyTerminateOutcome } from './service/termination.js';
// The one definition of "the runtime ended this", shared by every domain that
// brings an interrupted incarnation back.
export { interruptedByRuntime } from './types.js';
export {
  PtyKillError,
  PtyResizeError,
  PtyServiceError,
  PtyStartError,
  PtyTeardownError,
  PtyWriteError,
} from './types.js';
export { registerPtyStreamRoute } from './stream-route.js';
export type { PtyStreamStrategy } from './stream-route.js';
