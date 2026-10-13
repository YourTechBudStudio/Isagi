import { eq, inArray } from 'drizzle-orm';
import { Effect, Layer } from 'effect';

import {
  HarnessObservationTargets,
  ptyIncarnation,
  type HarnessObservationTarget,
} from '../../harnesses/index.js';
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
              createdAt: ptyProcesses.createdAt,
            })
            .from(agentSessions)
            .leftJoin(ptyProcesses, eq(agentSessions.activePtyProcessId, ptyProcesses.id));
          const rows =
            input.mode === 'live'
              ? base.where(inArray(ptyProcesses.status, ['starting', 'running'])).all()
              : input.mode === 'one' && input.id !== undefined
                ? base.where(eq(agentSessions.id, input.id)).all()
                : base.all();
          return rows.map(
            (row): HarnessObservationTarget => ({
              agentSessionId: row.agentSessionId,
              harness: row.harness,
              // The pointer's row always exists (foreign key), so a pointer comes with `createdAt`.
              activeExecution:
                row.activePtyProcessId !== null && row.createdAt !== null
                  ? {
                      kind: 'pty',
                      incarnation: ptyIncarnation(row.activePtyProcessId),
                      ptyProcessId: row.activePtyProcessId,
                      status: row.status,
                      statusReason: row.statusReason,
                      since: row.createdAt,
                    }
                  : null,
            }),
          );
        }),
    });
  }),
);
