import { Data } from 'effect';

import {
  coordinates,
  describeSafely,
  type SafeDescription,
  type SafeDiagnostic,
} from '../platform/diagnostics/index.js';

/** Fluidcast cannot start for this agent: the section is off or invalid, or the harness has no SDK worker. */
export class FluidcastUnavailable
  extends Data.TaggedError('FluidcastUnavailable')<{
    readonly reason: 'disabled' | 'invalid_config' | 'harness_unsupported';
  }>
  implements SafeDiagnostic
{
  [describeSafely](): SafeDescription {
    return { label: `Fluidcast unavailable ${this.reason}`, cause: null };
  }
}

/** The agent's native session could not be attached; nothing was replaced. */
export class FluidcastSessionUnreadable
  extends Data.TaggedError('FluidcastSessionUnreadable')<{
    readonly reason: 'SessionNotFound' | 'SessionUnreadable';
  }>
  implements SafeDiagnostic
{
  [describeSafely](): SafeDescription {
    return { label: `Fluidcast session unreadable ${this.reason}`, cause: null };
  }
}

/** The session could not be built. */
export class FluidcastStartFailed
  extends Data.TaggedError('FluidcastStartFailed')<{
    readonly reason: 'executable_not_found' | 'instrumentation_failed' | 'session_build_failed';
  }>
  implements SafeDiagnostic
{
  [describeSafely](): SafeDescription {
    return { label: `Fluidcast start failed ${this.reason}`, cause: null };
  }
}

/** No live session has this ID: it never existed or was stopped. */
export class FluidcastSessionNotFound
  extends Data.TaggedError('FluidcastSessionNotFound')<{ readonly fluidcastSessionId: string }>
  implements SafeDiagnostic
{
  [describeSafely](): SafeDescription {
    return {
      label: `Fluidcast session not found${coordinates({ fluidcastSession: this.fluidcastSessionId })}`,
      cause: null,
    };
  }
}
