import { Context, type Effect } from 'effect';

import type { AgentHarness, SessionStatus } from '@isagi/contracts';

import type { DatabaseError } from '../platform/persistence/index.js';
import type { Incarnation } from './incarnation.js';

/**
 * The execution currently controlling an agent session. `since` is a lower bound on anything the
 * execution writes: the PTY row's `createdAt`, or the time the SDK execution was minted.
 */
export type ActiveExecution =
  | {
      readonly kind: 'pty';
      readonly incarnation: Incarnation;
      readonly ptyProcessId: number;
      readonly status: SessionStatus | null;
      readonly statusReason: string | null;
      readonly since: string;
    }
  | {
      readonly kind: 'sdk';
      readonly incarnation: Incarnation;
      readonly executionId: string;
      /** False once the controller ended or its worker faulted. */
      readonly live: boolean;
      readonly since: string;
    };

/**
 * One agent session the ledger observer watches: which harness interprets its ledger, and the
 * execution (with its liveness) whose lifecycle it correlates turns against.
 */
export interface HarnessObservationTarget {
  readonly agentSessionId: number;
  readonly harness: AgentHarness;
  readonly activeExecution: ActiveExecution | null;
}

/**
 * Port: the agent sessions the harness ledger observer should watch.
 *
 * Harnesses sit below the environment, which owns agent sessions, so the observer cannot read the
 * session table itself. The environment implements this port (`HarnessObservationTargetsLayer`)
 * and only the composition root wires it.
 *
 * `all` lists every agent session, `live` only those whose active execution may still write,
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
