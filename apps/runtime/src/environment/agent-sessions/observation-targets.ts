import { eq, inArray } from 'drizzle-orm';
import { Effect, Layer } from 'effect';

import { HarnessObservationTargets, type HarnessObservationTarget } from '../../harnesses/index.js';
import { RuntimeDatabase } from '../../platform/persistence/index.js';
import { ptyProcesses } from '../../pty-processes/tables.js';
import { agentSessions } from '../tables.js';

/**
 * The environment's answer to the harness observer's port: every agent session joined onto its
 * active PTY process. Imported only by the composition root (and tests that build the observer).
 */
export const HarnessObservationTargetsLayer = Layer.effect(
  HarnessObservationTargets,
  Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    return HarnessObservationTargets.of({
      list: (input) =>
        database.use(`harness_observer_inventory_${input.mode}`, (db) => {
          const base = db
            .select({
              agentSessionId: agentSessions.id,
              harness: agentSessions.harness,
              activePtyProcessId: agentSessions.activePtyProcessId,
              status: ptyProcesses.status,
              statusReason: ptyProcesses.statusReason,
            })
            .from(agentSessions)
            .leftJoin(ptyProcesses, eq(agentSessions.activePtyProcessId, ptyProcesses.id));
          const rows =
            input.mode === 'live'
              ? base.where(inArray(ptyProcesses.status, ['starting', 'running'])).all()
              : input.mode === 'one' && input.id !== undefined
                ? base.where(eq(agentSessions.id, input.id)).all()
                : base.all();
          return rows.map((row) => row as HarnessObservationTarget);
        }),
    });
  }),
);
