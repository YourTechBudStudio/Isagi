import { Context, Data, Effect, Layer } from 'effect';

import { type Incarnation, ptyIncarnation } from '../../harnesses/index.js';
import { InternalEvents } from '../../platform/events/index.js';
import { DatabaseError } from '../../platform/persistence/index.js';
import { terminalShellCommand } from '../../platform/process/index.js';
import { PtyService, type PtyLaunchError } from '../../pty-processes/index.js';
import { SessionLifecycle } from '../sessions/lifecycle.js';
import type { TerminalSessionRow } from '../sessions/types.js';
import { TerminalSessionRepository } from './repository.js';

export interface TerminalSessionEnsureActiveOptions {
  readonly replaceEphemeralProcess?: boolean | undefined;
  /**
   * Attach to this live incarnation only: never launch or replace a process, and refuse with
   * `process_incarnation_stale` when the session's live process is another one or none.
   */
  readonly expectedIncarnation?: Incarnation | undefined;
}

export type TerminalSessionErrorCode =
  | 'session_not_found'
  | 'active_process_missing'
  | 'active_process_not_running'
  /** The incarnation an attach named is no longer the session's live process. */
  | 'process_incarnation_stale';

/**
 * A terminal session operation was refused. Constructed positionally (`new TerminalSessionError(code, message)`), as
 * it was before it became a tagged error, so existing call sites keep their shape.
 */
export class TerminalSessionError extends Data.TaggedError('TerminalSessionError')<{
  readonly code: TerminalSessionErrorCode;
  readonly message: string;
}> {
  constructor(code: TerminalSessionErrorCode, message: string) {
    super({ code, message });
  }
}

const make = Effect.gen(function* () {
  const repository = yield* TerminalSessionRepository;
  const pty = yield* PtyService;
  const eventBus = yield* InternalEvents;
  const lifecycle = yield* SessionLifecycle;

  const publishChanged = (terminalSessionId: number) =>
    eventBus.publish({ type: 'terminal_session_changed', terminalSessionId });

  const launchProcessForSession = Effect.fnUntraced(function* (session: TerminalSessionRow) {
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

  return TerminalSessionService.of({
    startFresh: Effect.fn('TerminalSessionService.startFresh')(function* (input) {
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
    get: Effect.fn('TerminalSessionService.get')(function* (terminalSessionId) {
      return yield* findTerminalSessionOrFail(repository, terminalSessionId);
    }),
    ensureActivePtyProcess: Effect.fn('TerminalSessionService.ensureActivePtyProcess')(
      function* (terminalSessionId, options) {
        return yield* lifecycle.withRestoreLock(
          { kind: 'terminal_session', sessionId: terminalSessionId },
          Effect.gen(function* () {
            const session = yield* findTerminalSessionOrFail(repository, terminalSessionId);
            const process = session.activePtyProcess;
            if (options?.expectedIncarnation !== undefined) {
              const live =
                session.activePtyProcessId !== null &&
                (process?.status === 'running' || process?.status === 'starting') &&
                ptyIncarnation(session.activePtyProcessId) === options.expectedIncarnation;
              if (live) return session.activePtyProcessId;
              return yield* new TerminalSessionError(
                'process_incarnation_stale',
                `Terminal session ${terminalSessionId} is no longer running ${options.expectedIncarnation}.`,
              );
            }
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
      },
    ),
    activePtyProcessId: Effect.fn('TerminalSessionService.activePtyProcessId')(
      function* (terminalSessionId) {
        const session = yield* findTerminalSessionOrFail(repository, terminalSessionId);
        if (!session.activePtyProcessId || !session.activePtyProcess)
          return yield* new TerminalSessionError(
            'active_process_missing',
            `Terminal session ${terminalSessionId} has no active PTY process.`,
          );
        if (session.activePtyProcess.status !== 'running')
          return yield* new TerminalSessionError(
            'active_process_not_running',
            `Terminal session ${terminalSessionId} active process is not running.`,
          );
        return session.activePtyProcessId;
      },
    ),
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

const findTerminalSessionOrFail = Effect.fnUntraced(function* (
  repository: TerminalSessionRepository['Service'],
  terminalSessionId: number,
) {
  const session = yield* repository.find(terminalSessionId);
  if (!session) {
    return yield* new TerminalSessionError(
      'session_not_found',
      `Terminal session ${terminalSessionId} was not found.`,
    );
  }
  return session;
});
