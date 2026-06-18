import { Effect } from 'effect';

import type { PtyRepositoryService } from '../pty.repository.js';
import type { PtyBackend, PtyBackendGcFinding, PtyBackendGcSession } from '../types.js';
import { decodeBackendRef } from './backend-ref.js';

const ptyGcIntervalMs = 5 * 60_000;

export function startPtyGcLoop(
  repository: PtyRepositoryService,
  backend: PtyBackend,
  runtimeNamespace: string,
) {
  const timer = setInterval(() => {
    void Effect.runPromise(
      runPtyGc(repository, backend, runtimeNamespace).pipe(
        Effect.catchAll((error) =>
          Effect.sync(() => {
            console.warn('[runtime] PTY backend GC failed', error);
          }),
        ),
      ),
    );
  }, ptyGcIntervalMs);
  timer.unref();
  return timer;
}

export function runPtyGc(
  repository: PtyRepositoryService,
  backend: PtyBackend,
  runtimeNamespace: string,
) {
  return Effect.gen(function* () {
    if (!backend.collectGarbage) {
      return;
    }
    const sessions = yield* collectGcSessions(repository);
    const findings = yield* backend.collectGarbage({ runtimeNamespace, sessions }).pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => {
          console.warn(
            `[runtime] Could not collect PTY backend GC findings backend=${backend.name}`,
            error,
          );
          return [];
        }),
      ),
    );
    for (const finding of findings) {
      yield* applyGcFinding(backend, finding);
    }
  });
}

function collectGcSessions(repository: PtyRepositoryService) {
  return Effect.gen(function* () {
    const sessions = yield* repository.listProcesses();
    const decoded: PtyBackendGcSession[] = [];
    for (const session of sessions) {
      const ref = yield* decodeBackendRef(session).pipe(Effect.orElseSucceed(() => null));
      if (!ref) {
        continue;
      }
      decoded.push({ ptyProcessId: session.id, ref, status: session.status });
    }
    return decoded;
  });
}

function applyGcFinding(backend: PtyBackend, finding: PtyBackendGcFinding) {
  const reason =
    finding.type === 'orphan_backend_session'
      ? 'orphan backend session'
      : `terminal ${finding.status} PTY row`;
  console.warn(
    `[runtime] Killing ${reason} during PTY backend GC backend=${backend.name} ptyProcessId=${finding.ptyProcessId}`,
  );
  return backend.kill(finding.ref).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        console.warn(
          `[runtime] Failed to kill PTY backend session during GC backend=${backend.name} ptyProcessId=${finding.ptyProcessId}`,
          error,
        );
      }),
    ),
  );
}
