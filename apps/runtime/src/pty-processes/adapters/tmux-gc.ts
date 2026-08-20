import { Effect } from 'effect';

import type {
  PtyBackendGcFinding,
  PtyBackendGcInput,
  PtyInspectError,
  TmuxBackendRef,
} from '../types.js';

export function collectTmuxGarbage(
  input: PtyBackendGcInput,
  listSessions: Effect.Effect<readonly TmuxBackendRef[], PtyInspectError>,
) {
  return Effect.gen(function* () {
    const backendSessions = yield* listSessions;
    const persisted = new Map(input.sessions.map((session) => [session.ptyProcessId, session]));
    const findings: PtyBackendGcFinding[] = [];

    for (const ref of backendSessions) {
      const parsed = parseRuntimeTmuxSessionName(ref.sessionName, input.runtimeNamespace);
      if (!parsed) {
        continue;
      }
      const session = persisted.get(parsed.ptyProcessId);
      // A row whose incarnation is not a tmux one does not own this tmux session,
      // even though the session name embeds its id. The session is an orphan by
      // the only identity that matters here — the persisted backend ref (ADR
      // 0005) — so treating the id match as ownership would strand it forever.
      if (!session || session.ref.backend !== 'tmux') {
        findings.push({
          type: 'orphan_backend_session',
          ref,
          ptyProcessId: parsed.ptyProcessId,
        });
        continue;
      }
      if (
        session.status === 'exited' ||
        session.status === 'failed' ||
        session.status === 'killed'
      ) {
        findings.push({
          type: 'terminal_backend_session',
          ref,
          ptyProcessId: session.ptyProcessId,
          status: session.status,
        });
      }
    }

    return findings;
  });
}

function parseRuntimeTmuxSessionName(sessionName: string, runtimeNamespace: string) {
  const match = new RegExp(`^isagi_${escapeRegExp(runtimeNamespace)}_(\\d+)$`).exec(sessionName);
  if (!match?.[1]) {
    return null;
  }
  const ptyProcessId = Number(match[1]);
  return Number.isSafeInteger(ptyProcessId) && ptyProcessId > 0 ? { ptyProcessId } : null;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
