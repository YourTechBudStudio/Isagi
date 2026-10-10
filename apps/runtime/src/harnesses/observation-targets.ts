import { Context, type Effect } from 'effect';

import type { AgentHarness, SessionStatus } from '@isagi/contracts';

import type { DatabaseError } from '../platform/persistence/index.js';

/**
 * One agent session the ledger observer watches: which harness interprets its ledger, and the
 * PTY incarnation (with that process's status) whose lifecycle it correlates turns against.
 */
export interface HarnessObservationTarget {
  readonly agentSessionId: number;
  readonly harness: AgentHarness;
  readonly activePtyProcessId: number | null;
  readonly status: SessionStatus | null;
  readonly statusReason: string | null;
}

/**
 * Port: the agent sessions the harness ledger observer should watch.
 *
 * Harnesses sit below the environment, which owns agent sessions, so the observer cannot read the
 * session table itself. The environment implements this port (`HarnessObservationTargetsLayer`)
 * and only the composition root wires it.
 *
 * `all` lists every agent session, `live` only those whose active process is starting or running,
 * and `one` the session `id` (an empty list when it no longer exists).
 */
export class HarnessObservationTargets extends Context.Service<
  HarnessObservationTargets,
  {
    readonly list: (input: {
      readonly mode: 'all' | 'live' | 'one';
      readonly id?: number;
    }) => Effect.Effect<ReadonlyArray<HarnessObservationTarget>, DatabaseError>;
  }
>()('isagi/runtime/harnesses/HarnessObservationTargets') {}
