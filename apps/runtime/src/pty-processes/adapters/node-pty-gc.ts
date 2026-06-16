import { Effect } from 'effect';

import type {
  NodePtyBackendRef,
  PtyBackendGcFinding,
  PtyBackendGcInput,
  PtyInspectError,
} from '../types.js';

export function collectNodePtyGarbage(
  input: PtyBackendGcInput,
  listSessions: Effect.Effect<readonly NodePtyBackendRef[], PtyInspectError>,
) {
  return Effect.gen(function* () {
    const backendSessions = yield* listSessions;
    const persisted = new Map(input.sessions.map((session) => [session.ptySessionId, session]));
    const findings: PtyBackendGcFinding[] = [];

    for (const ref of backendSessions) {
      const session = persisted.get(ref.ptySessionId);
      if (!session || session.ref.backend !== 'node_pty') {
        findings.push({
          type: 'orphan_backend_session',
          ref,
          ptySessionId: ref.ptySessionId,
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
          ptySessionId: session.ptySessionId,
          status: session.status,
        });
      }
    }

    return findings;
  });
}
