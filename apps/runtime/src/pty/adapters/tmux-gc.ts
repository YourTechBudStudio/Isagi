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
    const persisted = new Map(input.sessions.map((session) => [session.ptySessionId, session]));
    const findings: PtyBackendGcFinding[] = [];

    for (const ref of backendSessions) {
      const parsed = parseRuntimeTmuxSessionName(ref.sessionName, input.runtimeNamespace);
      if (!parsed) {
        continue;
      }
      const session = persisted.get(parsed.ptySessionId);
      if (!session) {
        findings.push({
          type: 'orphan_backend_session',
          ref,
          ptySessionId: parsed.ptySessionId,
        });
        continue;
      }
      if (
        session.ref.backend === 'tmux' &&
        (session.status === 'exited' || session.status === 'failed' || session.status === 'killed')
      ) {
        findings.push({
          type: 'terminal_backend_session',
          ref,
          ptySessionId: session.ptySessionId,
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
  const ptySessionId = Number(match[1]);
  return Number.isSafeInteger(ptySessionId) && ptySessionId > 0 ? { ptySessionId } : null;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
