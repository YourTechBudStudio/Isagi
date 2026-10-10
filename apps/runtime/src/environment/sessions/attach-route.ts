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

import type { HarnessAdapterError, HarnessLaunchBlocked } from '../../harnesses/index.js';
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
  SessionLifecycle,
  type SessionLifecycleError,
  type SessionLifecycleKey,
} from './lifecycle.js';

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
    resolveProcessId: (sessionId) =>
      Effect.gen(function* () {
        const service = yield* AgentSessionService;
        return yield* service.ensureActivePtyProcess(sessionId);
      }),
  });
  registerSessionAttachRoute(fastify, runtime, {
    path: terminalSessionPtyWebSocketEndpoint.path,
    paramName: 'terminalSessionId',
    sessionKind: 'terminal_session',
    resolveProcessId: (sessionId) =>
      Effect.gen(function* () {
        const service = yield* TerminalSessionService;
        return yield* service.ensureActivePtyProcess(sessionId);
      }),
  });
}

interface SessionAttachTarget {
  readonly sessionId: number;
  readonly sessionKey: SessionLifecycleKey;
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
    readonly resolveProcessId: (
      sessionId: number,
    ) => Effect.Effect<number, SessionAttachError, AttachRouteServices>;
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
        yield* lifecycle.consumeAttachToken({ key: sessionKey, token: attachToken });
        const ptyProcessId = yield* input.resolveProcessId(sessionId);
        return { sessionId, sessionKey, ptyProcessId };
      }),
    preamble: ({ plan }) => sessionPreamble(plan),
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
    beforeAttach: (target) =>
      Effect.gen(function* () {
        const lifecycle = yield* SessionLifecycle;
        yield* lifecycle.supersedeAttachment(target.sessionKey);
      }),
    supersede: () => false,
    displace: () => undefined,
    registerAttachment: ({ target, controls }) =>
      Effect.gen(function* () {
        const lifecycle = yield* SessionLifecycle;
        return yield* lifecycle.registerActiveAttachment({
          key: target.sessionKey,
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

function sessionPreamble(plan: PtyAttachmentPlan | null): SessionPreamble {
  if (!plan) {
    return {
      type: 'session',
      status: 'failed',
      exitCode: null,
      signal: null,
    };
  }
  return {
    type: 'session',
    status: plan.session.status,
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
