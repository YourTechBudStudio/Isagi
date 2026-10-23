import { eq, inArray, or } from 'drizzle-orm';
import { Effect, Layer } from 'effect';

import {
  HarnessObservationTargets,
  ptyIncarnation,
  sdkIncarnation,
  type ActiveExecution,
  type HarnessObservationTarget,
} from '../../harnesses/index.js';
import { RuntimeDatabase } from '../../platform/persistence/index.js';
import { ptyProcesses } from '../../pty-processes/tables.js';
import { agentSessions } from '../tables.js';
import { AgentSessionInteraction, type AgentControl } from './interaction.js';

/**
 * The environment's answer to the harness observer's port: every agent session with its active
 * execution. A Fluidcast-mode agent reports its SDK execution, whatever the stale PTY pointer says;
 * any other agent reports the PTY its pointer names. Imported only by the composition root (and
 * tests that build the observer).
 */
export const HarnessObservationTargetsLayerNoDeps = Layer.effect(
  HarnessObservationTargets,
  Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    const interaction = yield* AgentSessionInteraction;
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
              ? // An ended SDK execution stays listed so its final records are still tailed.
                base
                  .where(
                    or(
                      inArray(ptyProcesses.status, ['starting', 'running']),
                      inArray(agentSessions.id, [...interaction.fluidcastAgentIds()]),
                    ),
                  )
                  .all()
              : input.mode === 'one' && input.id !== undefined
                ? base.where(eq(agentSessions.id, input.id)).all()
                : base.all();
          return rows.map((row): HarnessObservationTarget => ({
            agentSessionId: row.agentSessionId,
            harness: row.harness,
            activeExecution: activeExecution(row, interaction.control(row.agentSessionId)),
          }));
        }),
    });
  }),
);

/** The port with its interaction wired: the one `AgentSessionInteraction.layer` every consumer shares. */
export const HarnessObservationTargetsLayer = HarnessObservationTargetsLayerNoDeps.pipe(
  Layer.provide(AgentSessionInteraction.layer),
);

function activeExecution(
  row: {
    readonly activePtyProcessId: number | null;
    readonly status: ActivePty['status'];
    readonly statusReason: string | null;
    readonly createdAt: string | null;
  },
  control: AgentControl,
): ActiveExecution | null {
  if (control.mode === 'fluidcast')
    return {
      kind: 'sdk',
      incarnation: sdkIncarnation(control.fluidcastSessionId),
      executionId: control.fluidcastSessionId,
      live: control.worker.state === 'live',
      since: control.since,
    };
  // The pointer's row always exists (foreign key), so a pointer comes with `createdAt`.
  if (row.activePtyProcessId === null || row.createdAt === null) return null;
  return {
    kind: 'pty',
    incarnation: ptyIncarnation(row.activePtyProcessId),
    ptyProcessId: row.activePtyProcessId,
    status: row.status,
    statusReason: row.statusReason,
    since: row.createdAt,
  };
}

type ActivePty = Extract<ActiveExecution, { readonly kind: 'pty' }>;
