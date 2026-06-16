import { Context, Effect, Layer } from 'effect';

import type { LaunchTerminalSessionOutput } from '@isagi/contracts';

import { DatabaseError } from '../persistence/index.js';
import { PtyService, type PtyLaunchError } from '../pty-processes/pty.service.js';
import { terminalShellCommand } from '../pty-processes/service/runtime-namespace.js';
import { InternalRuntimeEventBus } from '../runtime-events/index.js';
import { SurfaceRepository } from '../surfaces/index.js';
import type { TerminalSessionRow } from '../surfaces/types.js';
import { TerminalSessionRepository } from './terminal-sessions.repository.js';

export interface TerminalSessionService {
  readonly launch: (input: {
    readonly worktreeId: number;
  }) => Effect.Effect<LaunchTerminalSessionOutput, DatabaseError | PtyLaunchError>;
  readonly ensureActivePtyProcess: (
    terminalSessionId: number,
  ) => Effect.Effect<number, DatabaseError | TerminalSessionError | PtyLaunchError>;
  readonly activePtyProcessId: (
    terminalSessionId: number,
  ) => Effect.Effect<number, DatabaseError | TerminalSessionError>;
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
    const surfaces = yield* SurfaceRepository;
    const pty = yield* PtyService;
    const eventBus = yield* InternalRuntimeEventBus;
    const restoreLocks = new Map<number, Promise<void>>();

    const publishChanged = (terminalSessionId: number) =>
      eventBus.publish({ type: 'terminal_session_changed', terminalSessionId });

    const launchProcessForSession = (session: TerminalSessionRow) =>
      Effect.gen(function* () {
        const process = yield* pty.launch({
          command: session.shellCommand,
          args: session.shellArgs,
          cwd: session.cwd,
        });
        yield* repository.setActivePtyProcess({
          terminalSessionId: session.id,
          ptyProcessId: process.ptyProcessId,
        });
        yield* publishChanged(session.id);
        return process.ptyProcessId;
      });

    const ensureActivePtyProcess = (terminalSessionId: number) =>
      withSessionLock(
        restoreLocks,
        terminalSessionId,
        Effect.gen(function* () {
          const session = yield* findTerminalSessionOrFail(repository, terminalSessionId);
          const process = session.activePtyProcess;
          if (session.activePtyProcessId && process?.status === 'running') {
            return session.activePtyProcessId;
          }
          if (session.activePtyProcessId && process?.status === 'starting') {
            return session.activePtyProcessId;
          }
          return yield* launchProcessForSession(session);
        }),
      );

    return {
      launch: (input) =>
        Effect.gen(function* () {
          const surface = yield* surfaces.createSinglePaneSurface({
            worktreeId: input.worktreeId,
            kind: 'terminal',
            titleBase: 'Terminal',
          });
          const shellCommand = terminalShellCommand();
          const terminalSessionId = yield* repository.create({
            paneId: surface.paneId,
            worktreeId: input.worktreeId,
            cwd: surface.cwd,
            shellCommand,
            shellArgs: [],
          });
          const process = yield* pty.launch({ command: shellCommand, args: [], cwd: surface.cwd });
          yield* repository.setActivePtyProcess({
            terminalSessionId,
            ptyProcessId: process.ptyProcessId,
          });
          yield* publishChanged(terminalSessionId);
          return {
            worktreeId: input.worktreeId,
            surfaceId: surface.surfaceId,
            paneId: surface.paneId,
            terminalSessionId,
          } satisfies LaunchTerminalSessionOutput;
        }),
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

function withSessionLock<A, E>(
  locks: Map<number, Promise<void>>,
  sessionId: number,
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, E> {
  return Effect.acquireUseRelease(
    acquireSessionLock(locks, sessionId),
    () => effect,
    (release) => Effect.sync(release),
  );
}

function acquireSessionLock(locks: Map<number, Promise<void>>, sessionId: number) {
  return Effect.promise(() => {
    const previous = locks.get(sessionId) ?? Promise.resolve();
    let releaseCurrent: () => void = () => {};
    const current = previous
      .catch(() => {})
      .then(
        () =>
          new Promise<void>((resolve) => {
            releaseCurrent = resolve;
          }),
      );
    locks.set(sessionId, current);
    return previous
      .catch(() => {})
      .then(() => () => {
        releaseCurrent();
        if (locks.get(sessionId) === current) {
          locks.delete(sessionId);
        }
      });
  });
}
