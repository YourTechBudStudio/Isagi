import type { AgentSessionRow, TerminalSessionRow } from './types.js';

export function activePtyProcessIdsForSessions(sessions: {
  readonly agents: readonly AgentSessionRow[];
  readonly terminals: readonly TerminalSessionRow[];
}) {
  return activePtyProcessIds({
    agentSessionActivePtyProcessIds: sessions.agents.flatMap((session) =>
      activePtyProcessIdForTermination(session),
    ),
    terminalSessionActivePtyProcessIds: sessions.terminals.flatMap((session) =>
      activePtyProcessIdForTermination(session),
    ),
  });
}

export function activePtyProcessIds(input: {
  readonly agentSessionActivePtyProcessIds: readonly number[];
  readonly terminalSessionActivePtyProcessIds: readonly number[];
}) {
  return [
    ...new Set([
      ...input.agentSessionActivePtyProcessIds,
      ...input.terminalSessionActivePtyProcessIds,
    ]),
  ];
}

function activePtyProcessIdForTermination(
  session: AgentSessionRow | TerminalSessionRow,
): readonly number[] {
  if (!session.activePtyProcessId) return [];
  const status = session.activePtyProcess?.status ?? null;
  return status === 'starting' || status === 'running' ? [session.activePtyProcessId] : [];
}
