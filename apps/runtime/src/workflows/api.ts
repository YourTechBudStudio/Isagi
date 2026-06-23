import { Effect, type ManagedRuntime } from 'effect';
import type { FastifyInstance } from 'fastify';

import type { RuntimeServices } from '../runtime.layer.js';
import { WorkflowEngine } from './workflow-engine.service.js';

const defaultWorkflowKey = 'pi-gate';

export function registerWorkflowDevApi(
  fastify: FastifyInstance,
  runtime: ManagedRuntime.ManagedRuntime<RuntimeServices, unknown>,
) {
  fastify.post('/internal/dev/workflows/start', async (request, reply) => {
    const workflowKey = workflowKeyFromRequest(request.body, request.query) ?? defaultWorkflowKey;
    try {
      const run = await runtime.runPromise(
        Effect.gen(function* () {
          const engine = yield* WorkflowEngine;
          return yield* engine.startDevRun({ workflowKey });
        }),
      );
      return reply.status(200).send({ workflowRunId: run.id, workflowKey: run.workflowKey });
    } catch (error) {
      request.log.error({ error }, 'Workflow dev start failed');
      return reply.status(500).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  fastify.post('/internal/dev/workflows/continue', async (request, reply) => {
    const workflowRunId = workflowRunIdFromRequest(request.body, request.query);
    if (workflowRunId === null) {
      return reply.status(400).send({ error: 'workflowRunId is required.' });
    }
    try {
      const run = await runtime.runPromise(
        Effect.gen(function* () {
          const engine = yield* WorkflowEngine;
          return yield* engine.continueDevRun({ runId: workflowRunId });
        }),
      );
      return reply.status(200).send({ workflowRunId: run.id, status: run.status });
    } catch (error) {
      request.log.error({ error }, 'Workflow dev continue failed');
      return reply.status(500).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

function workflowKeyFromRequest(body: unknown, query: unknown) {
  const bodyKey = objectString(body, 'workflowKey');
  if (bodyKey) return bodyKey;
  return objectString(query, 'workflowKey');
}

function objectString(value: unknown, key: string) {
  if (!value || typeof value !== 'object') return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' && field.trim().length > 0 ? field.trim() : null;
}

function workflowRunIdFromRequest(body: unknown, query: unknown) {
  const bodyId = objectNumber(body, 'workflowRunId');
  if (bodyId !== null) return bodyId;
  return objectNumber(query, 'workflowRunId');
}

function objectNumber(value: unknown, key: string) {
  if (!value || typeof value !== 'object') return null;
  const field = (value as Record<string, unknown>)[key];
  if (typeof field === 'number' && Number.isSafeInteger(field) && field > 0) return field;
  if (typeof field !== 'string' || field.trim().length === 0) return null;
  const parsed = Number(field);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
