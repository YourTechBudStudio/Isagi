import { Layer } from 'effect';

import { AgentSessionAttentionProjection } from './agent-sessions/attention.js';
import { AgentSessionService } from './agent-sessions/service.js';
import { RuntimeEventProjection } from './runtime-event-projection.js';
import { SessionGc } from './sessions/gc.js';
import { SessionLifecycle } from './sessions/lifecycle.js';
import { SurfaceService } from './surfaces/service.js';
import { TerminalSessionService } from './terminal-sessions/service.js';

/**
 * The environment module's services, including its two background layers (the runtime-event projection and the
 * unplaced-session GC). Each service's `layer` wires its own module dependencies.
 */
export const EnvironmentLayer = Layer.mergeAll(
  SurfaceService.layer,
  AgentSessionService.layer,
  AgentSessionAttentionProjection.layer,
  TerminalSessionService.layer,
  SessionLifecycle.layer,
  RuntimeEventProjection.layer,
  SessionGc.layer,
);
