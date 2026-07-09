import { Context, Effect, Layer } from 'effect';

import { DatabaseError } from '../persistence/index.js';
import { PtyService, type PtyLaunchError } from '../pty-processes/pty.service.js';
import { terminalShellCommand } from '../pty-processes/service/runtime-namespace.js';
import { InternalRuntimeEventBus } from '../runtime-events/index.js';
import { SessionLifecycle } from '../session-lifecycle/index.js';
import type { TerminalSessionRow } from '../surfaces/types.js';
import { TerminalSessionRepository } from './terminal-sessions.repository.js';

export interface TerminalSessionService {
  readonly startFresh: (input: {
    readonly worktreeId: number;
    readonly cwd: string;
  }) => Effect.Effect<{ readonly terminalSessionId: number }, DatabaseError>;
  readonly get: (
    terminalSessionId: number,
  ) => Effect.Effect<TerminalSessionRow, DatabaseError | TerminalSessionError>;
  readonly ensureActivePtyProcess: (
    terminalSessionId: number,
    options?: TerminalSessionEnsureActiveOptions,
  ) => Effect.Effect<number, DatabaseError | TerminalSessionError | PtyLaunchError>;
  readonly activePtyProcessId: (
    terminalSessionId: number,
  ) => Effect.Effect<number, DatabaseError | TerminalSessionError>;
}

export interface TerminalSessionEnsureActiveOptions {
  readonly replaceEphemeralProcess?: boolean | undefined;
}

export class TerminalSessionError extends Error {
  readonly _tag = 'TerminalSessionError';
  constructor(
    readonly code: 'session_not_found' | 'active_process_missing' | 'active_process_not_running',
    message: string,
  ) {
    super(message);
  }
}

export const TerminalSessionService = Context.GenericTag<TerminalSessionService>(
  'isagi/TerminalSessionService',
);

export const TerminalSessionServiceLive = Layer.effect(
  TerminalSessionService,
  Effect.gen(function* () {
    const repository = yield* TerminalSessionRepository;
    const pty = yield* PtyService;
    const eventBus = yield* InternalRuntimeEventBus;
    const lifecycle = yield* SessionLifecycle;

    const publishChanged = (terminalSessionId: number) =>
      eventBus.publish({ type: 'terminal_session_changed', terminalSessionId });

    const launchProcessForSession = (session: TerminalSessionRow) =>
      Effect.gen(function* () {
        const process = yield* pty.launch({
          command: session.shellCommand,
          args: session.shellArgs,
          cwd: session.cwd,
          shellIntegration: true,
        });
        yield* repository.setActivePtyProcess({
          terminalSessionId: session.id,
          ptyProcessId: process.ptyProcessId,
        });
        yield* publishChanged(session.id);
        return process.ptyProcessId;
      });

    const ensureActivePtyProcess = (
      terminalSessionId: number,
      options?: TerminalSessionEnsureActiveOptions,
    ) =>
      lifecycle.withRestoreLock(
        { kind: 'terminal_session', sessionId: terminalSessionId },
        Effect.gen(function* () {
          const session = yield* findTerminalSessionOrFail(repository, terminalSessionId);
          const process = session.activePtyProcess;
          const replaceEphemeralProcess =
            options?.replaceEphemeralProcess === true && process?.backend === 'node_pty';
          const canReuseActiveProcess =
            session.activePtyProcessId &&
            !replaceEphemeralProcess &&
            (process?.status === 'running' || process?.status === 'starting');
          if (canReuseActiveProcess) {
            return session.activePtyProcessId;
          }
          return yield* launchProcessForSession(session);
        }),
      );

    return {
      startFresh: (input) =>
        Effect.gen(function* () {
          const shellCommand = terminalShellCommand();
          const terminalSessionId = yield* repository.create({
            worktreeId: input.worktreeId,
            cwd: input.cwd,
            shellCommand,
            shellArgs: [],
          });
          yield* publishChanged(terminalSessionId);
          return { terminalSessionId };
        }),
      get: (terminalSessionId) => findTerminalSessionOrFail(repository, terminalSessionId),
      ensureActivePtyProcess,
      activePtyProcessId: (terminalSessionId) =>
        Effect.gen(function* () {
          const session = yield* findTerminalSessionOrFail(repository, terminalSessionId);
          if (!session.activePtyProcessId || !session.activePtyProcess)
            return yield* Effect.fail(
              new TerminalSessionError(
                'active_process_missing',
                `Terminal session ${terminalSessionId} has no active PTY process.`,
              ),
            );
          if (session.activePtyProcess.status !== 'running')
            return yield* Effect.fail(
              new TerminalSessionError(
                'active_process_not_running',
                `Terminal session ${terminalSessionId} active process is not running.`,
              ),
            );
          return session.activePtyProcessId;
        }),
    } satisfies TerminalSessionService;
  }),
);

function findTerminalSessionOrFail(
  repository: import('./terminal-sessions.repository.js').TerminalSessionRepositoryService,
  terminalSessionId: number,
) {
  return Effect.gen(function* () {
    const session = yield* repository.find(terminalSessionId);
    if (!session) {
      return yield* Effect.fail(
        new TerminalSessionError(
          'session_not_found',
          `Terminal session ${terminalSessionId} was not found.`,
        ),
      );
    }
    return session;
  });
}
