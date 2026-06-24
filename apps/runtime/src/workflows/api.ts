import { Cause, Effect, Option, Runtime, Schema, type ManagedRuntime } from 'effect';
import type { FastifyInstance } from 'fastify';

import type { RuntimeServices } from '../runtime.layer.js';
import { WorkflowEngineError } from './types.js';
import {
  WorkflowEngine,
  type WorkflowHumanWaitSatisfactionResult,
} from './workflow-engine.service.js';

const positiveIntegerSchema = Schema.Number.pipe(Schema.int(), Schema.positive());
const variablesSchema = Schema.Record({ key: Schema.String, value: Schema.Unknown });
const startContextSchema = Schema.Struct({
  worktreeId: positiveIntegerSchema,
  surfaceId: positiveIntegerSchema,
  paneId: Schema.optional(Schema.NullOr(positiveIntegerSchema)),
});
const listBodySchema = Schema.Struct({
  context: startContextSchema,
});
const startBodySchema = Schema.Struct({
  workflowKey: Schema.String.pipe(Schema.minLength(1)),
  variables: Schema.optional(variablesSchema),
  context: startContextSchema,
});
const continueBodySchema = Schema.Struct({
  workflowRunId: positiveIntegerSchema,
});
const satisfyUserContinueBodySchema = Schema.Struct({
  workflowRunId: positiveIntegerSchema,
});
const submitUserInputBodySchema = Schema.Struct({
  workflowRunId: positiveIntegerSchema,
  answers: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
});

export function registerWorkflowDevApi(
  fastify: FastifyInstance,
  runtime: ManagedRuntime.ManagedRuntime<RuntimeServices, unknown>,
) {
  fastify.post('/internal/dev/workflows/list', async (request, reply) => {
    const decoded = decodeBody(listBodySchema, request.body);
    if (!decoded.ok) return reply.status(400).send({ error: decoded.message });

    try {
      const workflows = await runtime.runPromise(
        Effect.gen(function* () {
          const engine = yield* WorkflowEngine;
          return yield* engine.listWorkflowDescriptors({ context: decoded.value.context });
        }),
      );
      return reply.status(200).send({ workflows });
    } catch (error) {
      request.log.error({ error }, 'Workflow dev list failed');
      return sendWorkflowDevError(reply, error);
    }
  });

  fastify.post('/internal/dev/workflows/start', async (request, reply) => {
    const decoded = decodeBody(startBodySchema, request.body);
    if (!decoded.ok) return reply.status(400).send({ error: decoded.message });

    try {
      const run = await runtime.runPromise(
        Effect.gen(function* () {
          const engine = yield* WorkflowEngine;
          return yield* engine.startWorkflow({
            workflowKey: decoded.value.workflowKey,
            variables: decoded.value.variables ?? {},
            context: decoded.value.context,
          });
        }),
      );
      return reply.status(200).send({ workflowRunId: run.id, workflowKey: run.workflowKey });
    } catch (error) {
      request.log.error({ error }, 'Workflow dev start failed');
      return sendWorkflowDevError(reply, error);
    }
  });

  fastify.post('/internal/dev/workflows/continue', async (request, reply) => {
    const decoded = decodeBody(continueBodySchema, request.body);
    if (!decoded.ok) return reply.status(400).send({ error: decoded.message });

    try {
      const run = await runtime.runPromise(
        Effect.gen(function* () {
          const engine = yield* WorkflowEngine;
          return yield* engine.continueDevRun({ runId: decoded.value.workflowRunId });
        }),
      );
      return reply.status(200).send({ workflowRunId: run.id, status: run.status });
    } catch (error) {
      request.log.error({ error }, 'Workflow dev continue failed');
      return sendWorkflowDevError(reply, error);
    }
  });

  fastify.post('/internal/dev/workflows/satisfy-user-continue', async (request, reply) => {
    const decoded = decodeBody(satisfyUserContinueBodySchema, request.body);
    if (!decoded.ok) return reply.status(400).send({ error: decoded.message });

    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const engine = yield* WorkflowEngine;
          return yield* engine.satisfyUserContinueDevRun({
            runId: decoded.value.workflowRunId,
          });
        }),
      );
      return reply.status(200).send(humanWaitResponse(result));
    } catch (error) {
      request.log.error({ error }, 'Workflow dev satisfy-user-continue failed');
      return sendWorkflowDevError(reply, error);
    }
  });

  fastify.post('/internal/dev/workflows/submit-user-input', async (request, reply) => {
    const decoded = decodeBody(submitUserInputBodySchema, request.body);
    if (!decoded.ok) return reply.status(400).send({ error: decoded.message });

    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const engine = yield* WorkflowEngine;
          return yield* engine.submitUserInputDevRun({
            runId: decoded.value.workflowRunId,
            answers: decoded.value.answers,
          });
        }),
      );
      return reply.status(200).send(humanWaitResponse(result));
    } catch (error) {
      request.log.error({ error }, 'Workflow dev submit-user-input failed');
      return sendWorkflowDevError(reply, error);
    }
  });
}

function humanWaitResponse(result: WorkflowHumanWaitSatisfactionResult) {
  return {
    outcome: result.outcome,
    workflowRunId: result.run.id,
    status: result.run.status,
    waitKind: result.run.waitKind,
  };
}

function decodeBody<Decoded>(schema: Schema.Schema<Decoded>, body: unknown) {
  try {
    return { ok: true as const, value: Schema.decodeUnknownSync(schema)(body) };
  } catch (error) {
    return {
      ok: false as const,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function sendWorkflowDevError(reply: import('fastify').FastifyReply, error: unknown) {
  const failure = unwrapEffectFailure(error);
  if (failure instanceof WorkflowEngineError) {
    return reply.status(400).send({ error: failure.message, code: failure.code });
  }
  return reply.status(500).send({
    error: error instanceof Error ? error.message : String(error),
  });
}

function unwrapEffectFailure(error: unknown) {
  if (!Runtime.isFiberFailure(error)) return error;
  const failure = Cause.failureOption(error[Runtime.FiberFailureCauseId]);
  return Option.isSome(failure) ? failure.value : error;
}
