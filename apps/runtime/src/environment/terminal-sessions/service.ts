import { Context, Effect, Layer } from 'effect';

import { InternalEvents } from '../../platform/events/index.js';
import { DatabaseError } from '../../platform/persistence/index.js';
import { terminalShellCommand } from '../../platform/process/index.js';
import { PtyService, type PtyLaunchError } from '../../pty-processes/index.js';
import { SessionLifecycle } from '../sessions/lifecycle.js';
import type { TerminalSessionRow } from '../sessions/types.js';
import { TerminalSessionRepository } from './repository.js';

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

const make = Effect.gen(function* () {
  const repository = yield* TerminalSessionRepository;
  const pty = yield* PtyService;
  const eventBus = yield* InternalEvents;
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

  return TerminalSessionService.of({
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
  });
});

export class TerminalSessionService extends Context.Service<
  TerminalSessionService,
  {
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
>()('isagi/runtime/environment/TerminalSessionService') {
  static readonly layerNoDeps = Layer.effect(TerminalSessionService, make);
  static readonly layer = TerminalSessionService.layerNoDeps.pipe(
    Layer.provide([
      InternalEvents.layer,
      PtyService.layer,
      SessionLifecycle.layer,
      TerminalSessionRepository.layer,
    ]),
  );
}

function findTerminalSessionOrFail(
  repository: import('./repository.js').TerminalSessionRepository['Service'],
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
