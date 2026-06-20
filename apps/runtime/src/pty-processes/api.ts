import { Data, Effect, Schema, type ManagedRuntime } from 'effect';
import type { FastifyInstance } from 'fastify';

import {
  agentSessionPtyWebSocketEndpoint,
  ptyWebSocketInputMessageSchema,
  terminalSessionPtyWebSocketEndpoint,
  type PtyWebSocketErrorCode,
  type PtyWebSocketInputMessage,
  type PtyWebSocketOutputMessage,
} from '@isagi/contracts';

import { AgentSessionError, AgentSessionService } from '../agent-sessions/index.js';
import { HarnessAdapterError } from '../harness-adapters/index.js';
import { errorMessage } from '../lib/api/index.js';
import { DatabaseError } from '../persistence/index.js';
import type { RuntimeServices } from '../runtime.layer.js';
import {
  SessionLifecycle,
  SessionLifecycleError,
  type SessionLifecycleKey,
} from '../session-lifecycle/index.js';
import { TerminalSessionError, TerminalSessionService } from '../terminal-sessions/index.js';
import { PtyService } from './pty.service.js';
import type { PtyAttachmentPlan } from './pty.service.js';
import { registerPtyStreamRoute, type PtyStreamStrategy } from './stream-route.js';
import { PtyResizeError, PtyServiceError, PtyWriteError } from './types.js';

const runWithRuntime =
  (runtime: ManagedRuntime.ManagedRuntime<RuntimeServices, unknown>) =>
  <A>(
    effect: Effect.Effect<A, unknown, RuntimeServices>,
    options?: { readonly signal?: AbortSignal | undefined },
  ) =>
    runtime.runPromise(effect, options);

export function registerPtyApi(
  fastify: FastifyInstance,
  runtime: ManagedRuntime.ManagedRuntime<RuntimeServices, unknown>,
) {
  const run = runWithRuntime(runtime);

  registerSessionAttachRoute(fastify, run, {
    path: agentSessionPtyWebSocketEndpoint.path,
    paramName: 'agentSessionId',
    sessionKind: 'agent_session',
    resolveProcessId: (sessionId) =>
      Effect.gen(function* () {
        const service = yield* AgentSessionService;
        return yield* service.ensureActivePtyProcess(sessionId);
      }),
  });
  registerSessionAttachRoute(fastify, run, {
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

function registerSessionAttachRoute(
  fastify: FastifyInstance,
  run: ReturnType<typeof runWithRuntime>,
  input: {
    readonly path: string;
    readonly paramName: 'agentSessionId' | 'terminalSessionId';
    readonly sessionKind: 'agent_session' | 'terminal_session';
    readonly resolveProcessId: (
      sessionId: number,
    ) => Effect.Effect<number, unknown, RuntimeServices>;
  },
) {
  const strategy: PtyStreamStrategy<SessionAttachTarget, SessionPreamble> = {
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
              controls.send({ type: 'error', code: 'session_attachment_moved' });
              yield* controls.detach;
              controls.close();
              yield* Effect.promise<void>(() => new Promise((resolve) => setImmediate(resolve)));
            }),
          },
        });
      }),
    mapError: websocketError,
  };

  registerPtyStreamRoute(fastify, run, strategy);
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

function websocketError(error: unknown): {
  readonly code: PtyWebSocketErrorCode;
  readonly message?: string;
} {
  if (error instanceof SessionAttachProtocolError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof AgentSessionError || error instanceof TerminalSessionError) {
    if (error instanceof AgentSessionError && error.code === 'harness_session_id_missing') {
      return { code: 'harness_session_id_missing', message: error.message };
    }
    if (error.code === 'active_process_missing') {
      return { code: 'active_process_missing', message: error.message };
    }
    if (error.code === 'active_process_not_running') {
      return { code: 'active_process_not_running', message: error.message };
    }
    return { code: 'session_not_found', message: error.message };
  }
  if (error instanceof HarnessAdapterError && error.code === 'unsupported_harness') {
    return { code: 'unsupported_harness', message: error.message };
  }
  if (error instanceof SessionLifecycleError) {
    if (error.code === 'attach_token_expired') {
      return { code: 'attach_token_expired', message: error.message };
    }
    if (error.code === 'attach_token_missing') {
      return { code: 'attach_token_missing', message: error.message };
    }
    return { code: 'attach_token_invalid', message: error.message };
  }
  if (error instanceof PtyServiceError) return { code: error.code, message: error.message };
  if (error instanceof PtyWriteError || error instanceof PtyResizeError) {
    return { code: 'pty_write_failed', message: error.message };
  }
  if (error instanceof DatabaseError) {
    return { code: 'pty_state_load_failed', message: `PTY state load failed: ${error.operation}` };
  }
  return { code: 'unknown', message: errorMessage(error) };
}
