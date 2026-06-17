import { Effect, Either, Schema, type ManagedRuntime } from 'effect';
import type { FastifyInstance } from 'fastify';

import { AgentSessionError } from '../agent-sessions/index.js';
import { isAllowedRuntimeOrigin } from '../lib/security/origin.js';
import type { RuntimeServices } from '../runtime.layer.js';
import { HarnessEventError, HarnessEventService } from './harness-events.service.js';

const harnessEventBodySchema = Schema.Struct({
  type: Schema.Literal('harness_session_observed'),
  harness: Schema.Literal('pi', 'opencode', 'claude', 'codex'),
  harnessSessionId: Schema.String.pipe(Schema.minLength(1)),
  source: Schema.optional(Schema.NullOr(Schema.String)),
  agentSessionId: Schema.optional(
    Schema.NullOr(Schema.Number.pipe(Schema.int(), Schema.positive())),
  ),
});

const runWithRuntime =
  (runtime: ManagedRuntime.ManagedRuntime<RuntimeServices, unknown>) =>
  <A>(effect: Effect.Effect<A, unknown, RuntimeServices>) =>
    runtime.runPromise(effect);

export function registerHarnessEventsApi(
  fastify: FastifyInstance,
  runtime: ManagedRuntime.ManagedRuntime<RuntimeServices, unknown>,
) {
  const run = runWithRuntime(runtime);

  fastify.post('/internal/harness-events', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && !isAllowedRuntimeOrigin(Array.isArray(origin) ? origin[0] : origin)) {
      console.warn('[runtime] Harness event rejected: forbidden origin', { origin });
      return reply.code(403).send({ error: 'forbidden' });
    }

    const token = bearerToken(request.headers.authorization);
    if (!token) {
      console.warn('[runtime] Harness event rejected: missing bearer token');
      return reply.code(401).send({ error: 'missing_bearer_token' });
    }

    const parsed = decodeHarnessEvent(request.body);
    if (!parsed) {
      console.warn('[runtime] Harness event rejected: invalid payload', {
        bodyType: typeof request.body,
      });
      return reply.code(400).send({ error: 'invalid_harness_event' });
    }

    console.info('[runtime] Harness event received', {
      type: parsed.type,
      harness: parsed.harness,
      harnessSessionId: parsed.harnessSessionId,
      source: parsed.source ?? null,
      agentSessionId: parsed.agentSessionId ?? null,
    });

    const result = await run(
      Effect.gen(function* () {
        const service = yield* HarnessEventService;
        yield* service.handle({
          token,
          event: {
            type: parsed.type,
            harness: parsed.harness,
            harnessSessionId: parsed.harnessSessionId,
            source: parsed.source ?? null,
            agentSessionId: parsed.agentSessionId ?? null,
          },
        });
      }).pipe(Effect.either),
    ).catch((error: unknown) => {
      console.error('[runtime] Harness event route failed', error);
      return null;
    });

    if (!result) {
      return reply.code(500).send({ error: 'harness_event_failed' });
    }
    if (Either.isRight(result)) {
      console.info('[runtime] Harness event accepted', {
        type: parsed.type,
        harness: parsed.harness,
        harnessSessionId: parsed.harnessSessionId,
        source: parsed.source ?? null,
        agentSessionId: parsed.agentSessionId ?? null,
      });
      return reply.code(204).send();
    }
    const error = result.left;
    if (error instanceof HarnessEventError) {
      console.warn('[runtime] Harness event rejected by service', {
        code: error.code,
        message: error.message,
        harness: parsed.harness,
        harnessSessionId: parsed.harnessSessionId,
        source: parsed.source ?? null,
        agentSessionId: parsed.agentSessionId ?? null,
      });
      return reply.code(error.code === 'token_not_found' ? 401 : 400).send({ error: error.code });
    }
    if (error instanceof AgentSessionError) {
      console.warn('[runtime] Harness event rejected by agent session service', {
        code: error.code,
        message: error.message,
        harness: parsed.harness,
        harnessSessionId: parsed.harnessSessionId,
        source: parsed.source ?? null,
        agentSessionId: parsed.agentSessionId ?? null,
      });
      return reply.code(400).send({ error: error.code });
    }
    console.error('[runtime] Harness event handling failed', error);
    return reply.code(500).send({ error: 'harness_event_failed' });
  });
}

function bearerToken(authorization: string | undefined) {
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1] || null;
}

function decodeHarnessEvent(body: unknown) {
  try {
    return Schema.decodeUnknownSync(harnessEventBodySchema)(body);
  } catch {
    return null;
  }
}
