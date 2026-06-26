import { Data, Effect, Either } from 'effect';

import type { AgentSessionRow, TerminalSessionRow } from '../surfaces/index.js';
import type { PtyService as PtyServiceShape } from './pty.service.js';

export class PtyTeardownError extends Data.TaggedError('PtyTeardownError')<{
  readonly operation: string;
  readonly ptyProcessIds: readonly number[];
  readonly cause: unknown;
}> {}

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

export function terminatePtyProcessIds(
  pty: PtyServiceShape,
  input: {
    readonly failurePolicy: 'best_effort' | 'required';
    readonly gracefulTimeoutMs: number;
    readonly operation: string;
    readonly ptyProcessIds: readonly number[];
  },
) {
  return Effect.gen(function* () {
    const results = yield* Effect.all(
      input.ptyProcessIds.map((ptyProcessId) =>
        pty.terminate({ ptyProcessId, gracefulTimeoutMs: input.gracefulTimeoutMs }).pipe(
          Effect.either,
          Effect.map((result) => ({ ptyProcessId, result })),
        ),
      ),
      { concurrency: 'unbounded' },
    );
    const failures = results.flatMap(({ ptyProcessId, result }) =>
      Either.isLeft(result) ? [{ ptyProcessId, cause: result.left }] : [],
    );
    if (failures.length === 0) return;

    for (const failure of failures) {
      console.warn(
        `[runtime] Failed to terminate PTY process operation=${input.operation} ptyProcessId=${failure.ptyProcessId}`,
        failure.cause,
      );
    }

    if (input.failurePolicy === 'required') {
      return yield* Effect.fail(
        new PtyTeardownError({
          operation: input.operation,
          ptyProcessIds: failures.map((failure) => failure.ptyProcessId),
          cause: failures[0]?.cause,
        }),
      );
    }
  });
}

function activePtyProcessIdForTermination(
  session: AgentSessionRow | TerminalSessionRow,
): readonly number[] {
  if (!session.activePtyProcessId) return [];
  const status = session.activePtyProcess?.status ?? null;
  return status === 'starting' || status === 'running' ? [session.activePtyProcessId] : [];
}
