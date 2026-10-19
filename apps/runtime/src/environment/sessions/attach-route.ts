import { Data, Effect, Schema } from 'effect';
import type { FastifyInstance } from 'fastify';

import {
  agentSessionPtyWebSocketEndpoint,
  ptyWebSocketInputMessageSchema,
  terminalSessionPtyWebSocketEndpoint,
  type PtyWebSocketErrorCode,
  type PtyWebSocketInputMessage,
  type PtyWebSocketOutputMessage,
} from '@isagi/contracts';

import {
  ptyIncarnation,
  type HarnessAdapterError,
  type HarnessLaunchBlocked,
  type Incarnation,
} from '../../harnesses/index.js';
import { errorMessage, type RouteRuntime } from '../../platform/http/index.js';
import type { DatabaseError } from '../../platform/persistence/index.js';
import {
  PtyService,
  registerPtyStreamRoute,
  type PtyStreamStrategy,
  type PtyResizeError,
  PtyServiceError,
  type PtyWriteError,
} from '../../pty-processes/index.js';
import type { PtyAttachmentPlan } from '../../pty-processes/index.js';
import { type AgentSessionError, AgentSessionService } from '../agent-sessions/service.js';
import { type TerminalSessionError, TerminalSessionService } from '../terminal-sessions/service.js';
import {
  type AttachTokenRecord,
  SessionLifecycle,
  SessionLifecycleError,
  type SessionLifecycleKey,
} from './lifecycle.js';
import { sessionProcessIncarnation } from './status.js';

/** The services the session attach routes use. */
type AttachRouteServices =
  | AgentSessionService
  | TerminalSessionService
  | SessionLifecycle
  | PtyService;

export function registerPtyApi(
  fastify: FastifyInstance,
  runtime: RouteRuntime<AttachRouteServices>,
) {
  registerSessionAttachRoute(fastify, runtime, {
    path: agentSessionPtyWebSocketEndpoint.path,
    paramName: 'agentSessionId',
    sessionKind: 'agent_session',
    resolveProcessId: (sessionId, token) =>
      Effect.gen(function* () {
        const service = yield* AgentSessionService;
        return yield* service.ensureActivePtyProcess(sessionId, {
          expectedIncarnation: token.expectedIncarnation ?? undefined,
          controllerGeneration: token.controllerGeneration ?? undefined,
        });
      }),
    admitAttach: (target) =>
      Effect.gen(function* () {
        const service = yield* AgentSessionService;
        yield* service.requireTerminalMode(
          target.sessionId,
          target.controllerGeneration ?? undefined,
        );
      }),
    liveIncarnation: (sessionId) =>
      Effect.gen(function* () {
        const service = yield* AgentSessionService;
        return sessionProcessIncarnation(yield* service.get(sessionId));
      }),
  });
  registerSessionAttachRoute(fastify, runtime, {
    path: terminalSessionPtyWebSocketEndpoint.path,
    paramName: 'terminalSessionId',
    sessionKind: 'terminal_session',
    resolveProcessId: (sessionId, token) =>
      Effect.gen(function* () {
        const service = yield* TerminalSessionService;
        return yield* service.ensureActivePtyProcess(sessionId, {
          expectedIncarnation: token.expectedIncarnation ?? undefined,
        });
      }),
    admitAttach: () => Effect.void,
    liveIncarnation: (sessionId) =>
      Effect.gen(function* () {
        const service = yield* TerminalSessionService;
        return sessionProcessIncarnation(yield* service.get(sessionId));
      }),
  });
}

interface SessionAttachTarget {
  readonly sessionId: number;
  readonly sessionKey: SessionLifecycleKey;
  /** Set when an automatic re-attach token admitted this stream; see `AttachTokenRecord`. */
  readonly expectedIncarnation: Incarnation | null;
  /** The agent interaction generation the admitting token was issued under; see `AttachTokenRecord`. */
  readonly controllerGeneration: number | null;
}

type SessionPreamble = Extract<PtyWebSocketOutputMessage, { readonly type: 'session' }>;

class SessionAttachProtocolError extends Data.TaggedError('SessionAttachProtocolError')<{
  readonly code: 'invalid_session_id';
  readonly message: string;
}> {}

/** Everything a session attach connection can fail with, mapped to its socket error frame by `websocketError`. */
type SessionAttachError =
  | SessionAttachProtocolError
  | SessionLifecycleError
  | AgentSessionError
  | TerminalSessionError
  | HarnessAdapterError
  | HarnessLaunchBlocked
  | PtyServiceError
  | PtyWriteError
  | PtyResizeError
  | DatabaseError;

function registerSessionAttachRoute(
  fastify: FastifyInstance,
  runtime: RouteRuntime<AttachRouteServices>,
  input: {
    readonly path: string;
    readonly paramName: 'agentSessionId' | 'terminalSessionId';
    readonly sessionKind: 'agent_session' | 'terminal_session';
    /**
     * The session's live process incarnation as its row says now. Read without the session's lock,
     * so callers that need it to stay current hold that lock themselves.
     */
    readonly liveIncarnation: (
      sessionId: number,
    ) => Effect.Effect<Incarnation | null, SessionAttachError, AttachRouteServices>;
    /**
     * The session's process to stream, for the consumed `token`. With its `expectedIncarnation` (an
     * automatic re-attach) it joins only that live process and never launches one.
     */
    readonly resolveProcessId: (
      sessionId: number,
      token: AttachTokenRecord,
    ) => Effect.Effect<number, SessionAttachError, AttachRouteServices>;
    /**
     * The session's own precondition for final attach admission, run under its lock ahead of
     * `beforeAttach`. It may only read: the lock is already held.
     */
    readonly admitAttach: (
      target: SessionAttachTarget,
    ) => Effect.Effect<void, SessionAttachError, AttachRouteServices>;
  },
) {
  const strategy: PtyStreamStrategy<
    SessionAttachTarget,
    SessionPreamble,
    SessionAttachError,
    AttachRouteServices
  > = {
    path: input.path,
    logLabel: `PTY websocket ${input.sessionKind} attach`,
    mode: 'interactive',
    resolveTarget: (request) =>
      Effect.gen(function* () {
        const sessionId = decodeSessionId(request.params, input.paramName);
        if (sessionId === null) {
          return yield* Effect.fail(
            new SessionAttachProtocolError({
              code: 'invalid_session_id',
              message: 'Session id must be a positive integer.',
            }),
          );
        }
        const attachToken = decodeAttachToken(request.query);
        const sessionKey = { kind: input.sessionKind, sessionId };
        const lifecycle = yield* SessionLifecycle;
        const token = yield* lifecycle.consumeAttachToken({ key: sessionKey, token: attachToken });
        const ptyProcessId = yield* input.resolveProcessId(sessionId, token);
        return {
          sessionId,
          sessionKey,
          ptyProcessId,
          expectedIncarnation: token.expectedIncarnation,
          controllerGeneration: token.controllerGeneration,
        };
      }),
    preamble: ({ target, plan }) => sessionPreamble(target.ptyProcessId, plan),
    decodeClientMessage,
    handleClientMessage: ({ target, attachmentId, message }) =>
      Effect.gen(function* () {
        if (target.ptyProcessId === null) {
          return yield* Effect.fail(
            new PtyServiceError({
              code: 'session_not_running',
              message: 'PTY process is not running.',
            }),
          );
        }
        const pty = yield* PtyService;
        if (message.type === 'input') {
          return yield* pty.write({
            ptyProcessId: target.ptyProcessId,
            attachmentId,
            data: message.data,
          });
        }
        return yield* pty.resize({
          ptyProcessId: target.ptyProcessId,
          attachmentId,
          cols: message.cols,
          rows: message.rows,
        });
      }),
    // Final admission holds the session's lock, which every launch and mode switch takes, from the
    // session's own check through registration. A switch therefore runs wholly before it (and the
    // attach is refused) or wholly after registration (and its termination ends the attachment).
    withAttachAdmission: (target, attach) =>
      Effect.gen(function* () {
        const lifecycle = yield* SessionLifecycle;
        return yield* lifecycle.withRestoreLock(
          target.sessionKey,
          input.admitAttach(target).pipe(Effect.andThen(attach)),
        );
      }),
    // Runs under the admission lock, so it must not take that lock again.
    beforeAttach: (target) =>
      Effect.gen(function* () {
        const lifecycle = yield* SessionLifecycle;
        const expected = target.expectedIncarnation;
        if (expected === null) return yield* lifecycle.supersedeAttachment(target.sessionKey);
        // Planning and replay can suspend after the target resolved, and a newer process may have
        // launched and been attached to meanwhile. Re-check, under the lock every launch takes,
        // that the expected process is still the live one before displacing anything, so a stale
        // rejoin refuses instead of moving a newer process's holder aside.
        const live = yield* input.liveIncarnation(target.sessionId);
        if (live !== expected)
          return yield* new SessionLifecycleError({
            code: 'process_incarnation_stale',
            message: `Session ${target.sessionId} is no longer running ${expected}.`,
          });
        yield* lifecycle.displaceObsoleteAttachment(target.sessionKey, expected);
      }),
    supersede: () => false,
    displace: () => undefined,
    registerAttachment: ({ target, controls }) =>
      Effect.gen(function* () {
        const lifecycle = yield* SessionLifecycle;
        return yield* lifecycle.registerActiveAttachment({
          key: target.sessionKey,
          incarnation: target.ptyProcessId === null ? null : ptyIncarnation(target.ptyProcessId),
          handle: {
            moved: Effect.gen(function* () {
              yield* controls.send({ type: 'error', code: 'session_attachment_moved' });
              yield* controls.detach;
              yield* controls.close;
            }),
          },
        });
      }),
    mapError: websocketError,
  };

  registerPtyStreamRoute(fastify, runtime, strategy);
}

/**
 * The stream's first message. It names the process incarnation this socket is bound to, which only
 * the socket can say for certain: resolving the target may itself have launched a new process the
 * client's session projection does not show yet.
 */
function sessionPreamble(
  ptyProcessId: number | null,
  plan: PtyAttachmentPlan | null,
): SessionPreamble {
  const processIncarnation = ptyProcessId === null ? null : ptyIncarnation(ptyProcessId);
  if (!plan) {
    return {
      type: 'session',
      status: 'failed',
      processIncarnation,
      exitCode: null,
      signal: null,
    };
  }
  return {
    type: 'session',
    status: plan.session.status,
    processIncarnation,
    exitCode: plan.session.exitCode,
    signal: plan.session.signal,
  };
}

function decodeSessionId(params: unknown, name: 'agentSessionId' | 'terminalSessionId') {
  if (!params || typeof params !== 'object' || !(name in params)) return null;
  const value = (params as Record<string, unknown>)[name];
  const decoded = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof decoded === 'number' && Number.isInteger(decoded) && decoded > 0 ? decoded : null;
}

function decodeAttachToken(query: unknown) {
  if (!query || typeof query !== 'object' || !('attachToken' in query)) return null;
  const value = (query as Record<string, unknown>).attachToken;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function decodeClientMessage(raw: string): PtyWebSocketInputMessage | null {
  try {
    return Schema.decodeUnknownSync(ptyWebSocketInputMessageSchema)(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function websocketError(error: SessionAttachError): {
  readonly code: PtyWebSocketErrorCode;
  readonly message?: string;
} {
  switch (error._tag) {
    case 'HarnessLaunchBlocked':
      return {
        code: error.reason,
        message: `Harness process creation is blocked: ${error.reason}.${error.diagnostic ? ` ${error.diagnostic}` : ''}`,
      };
    case 'SessionAttachProtocolError':
      return { code: error.code, message: error.message };
    // Every session error code is also a socket error code: a new code that is not fails to compile here.
    case 'AgentSessionError':
      // The interaction-mode refusals: only a mode change raises them, never an attach.
      if (error.code === 'session_not_placed' || error.code === 'session_deleting')
        return { code: 'unknown', message: error.message };
      // The agent's controller is not the terminal this attach was admitted for.
      if (error.code === 'not_in_terminal_mode' || error.code === 'interaction_changed')
        return { code: 'process_incarnation_stale', message: error.message };
      return { code: error.code, message: error.message };
    case 'TerminalSessionError':
      return { code: error.code, message: error.message };
    case 'HarnessAdapterError':
      return error.code === 'unsupported_harness'
        ? { code: 'unsupported_harness', message: error.message }
        : { code: 'unknown', message: errorMessage(error) };
    case 'SessionLifecycleError':
      return {
        code: error.code === 'attach_token_session_mismatch' ? 'attach_token_invalid' : error.code,
        message: error.message,
      };
    case 'PtyServiceError':
      return error.code === 'worktree_not_found'
        ? { code: 'session_not_found', message: error.message }
        : { code: error.code, message: error.message };
    case 'PtyWriteError':
    case 'PtyResizeError':
      return { code: 'pty_write_failed', message: error.message };
    case 'DatabaseError':
      return {
        code: 'pty_state_load_failed',
        message: `PTY state load failed: ${error.operation}`,
      };
  }
}
