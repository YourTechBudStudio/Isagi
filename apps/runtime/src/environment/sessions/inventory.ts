import { Effect } from 'effect';

import type { DurableSessionInventory } from '@isagi/contracts';

import type { DatabaseError, RuntimeDatabase } from '../../platform/persistence/index.js';
import { agentSessions, terminalSessions } from '../tables.js';

/**
 * Every durable session the runtime still owns, with its worktree scope. This is the
 * authoritative set clients reconcile their cached terminals against, so it is required:
 * an absent implementation would otherwise read as "all durable sessions are gone".
 */
export function listDurableSessionInventory(
  database: RuntimeDatabase['Service'],
): Effect.Effect<DurableSessionInventory, DatabaseError> {
  return Effect.all([
    database.use('list_agent_session_identities', (db) =>
      db
        .select({ sessionId: agentSessions.id, worktreeId: agentSessions.worktreeId })
        .from(agentSessions)
        .orderBy(agentSessions.id)
        .all(),
    ),
    database.use('list_terminal_session_identities', (db) =>
      db
        .select({ sessionId: terminalSessions.id, worktreeId: terminalSessions.worktreeId })
        .from(terminalSessions)
        .orderBy(terminalSessions.id)
        .all(),
    ),
  ]).pipe(
    Effect.map(([agents, terminals]) => ({
      sessions: [
        ...agents.map((identity) => ({ kind: 'agent_session' as const, ...identity })),
        ...terminals.map((identity) => ({ kind: 'terminal_session' as const, ...identity })),
      ],
    })),
  );
}
