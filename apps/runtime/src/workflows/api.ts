import { Effect, Either, Schema, type ManagedRuntime } from 'effect';
import type { FastifyInstance } from 'fastify';

import {
  apiBasePath,
  apiEndpoints,
  workflowEventsStreamInputMessageSchema,
  workflowEventsStreamOutputMessageSchema,
  workflowEventsStreamWebSocketEndpoint,
  type ApiError,
  type WorkflowEventsStreamErrorCode,
  type WorkflowEventsStreamOutputMessage,
} from '@isagi/contracts';

import { registerApiEndpoint, type ApiRouteContext, errorMessage } from '../lib/api/index.js';
import { isAllowedRuntimeOrigin } from '../lib/security/origin.js';
import { DatabaseError } from '../persistence/index.js';
import { InternalRuntimeEventBus } from '../runtime-events/index.js';
import type { RuntimeServices } from '../runtime.layer.js';
import { WorkflowEventLedger, WorkflowEventLedgerError } from './event-ledger.service.js';
import { WorkflowEngineError } from './types.js';
import { WorkflowEngine } from './workflow-engine.service.js';
import { WorkflowRunProjection } from './workflow-run-projection.service.js';

const runWithRuntime =
  (runtime: ManagedRuntime.ManagedRuntime<RuntimeServices, unknown>) =>
  <A>(
    effect: Effect.Effect<A, unknown, RuntimeServices>,
    options?: { readonly signal?: AbortSignal | undefined },
  ) =>
    runtime.runPromise(effect, options);

// Bound the snapshot sent on connect/replay so a long-lived surface's ledger can't
// ship an unbounded payload (and overfill the client's bounded buffer). Events are
// chronological, so the most recent N are what the panel shows. Keep aligned with the
// client cap in apps/web/src/lib/workspace/workflow-events/stream.ts.
const maxSnapshotEvents = 1000;

function capRecentEvents<T>(events: readonly T[]): readonly T[] {
  return events.length > maxSnapshotEvents
    ? events.slice(events.length - maxSnapshotEvents)
    : events;
}

export function registerWorkflowApi(
  fastify: FastifyInstance,
  runtime: ManagedRuntime.ManagedRuntime<RuntimeServices, unknown>,
) {
  const run = runWithRuntime(runtime);

  registerApiEndpoint(fastify, apiEndpoints.workflows.descriptors, {
    handle: (input) =>
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine;
        const workflows = yield* engine.listWorkflowDescriptors({ context: input.context });
        return { workflows: [...workflows] };
      }),
    mapError: (error, context) => toWorkflowApiError(error, context),
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.workflows.listRuns, {
    handle: (_input, _context, _params, query) =>
      Effect.gen(function* () {
        const projection = yield* WorkflowRunProjection;
        const runs = yield* projection.listSummaries({
          surfaceId: query.surfaceId,
          worktreeId: query.worktreeId,
          status: query.status,
          rootOnly: query.rootOnly === undefined ? true : booleanQuery(query.rootOnly),
        });
        return { runs: [...runs] };
      }),
    mapError: (error, context) => toWorkflowApiError(error, context),
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.workflows.getRun, {
    handle: (_input, _context, params) =>
      Effect.gen(function* () {
        const projection = yield* WorkflowRunProjection;
        const runSummary = yield* projection.getSummary(params.runId);
        if (!runSummary) {
          return yield* Effect.fail(
            new WorkflowEngineError({
              code: 'workflow_run_not_found',
              message: `Workflow run ${params.runId} was not found.`,
              workflowRunId: params.runId,
            }),
          );
        }
        return { run: runSummary };
      }),
    mapError: (error, context) => toWorkflowApiError(error, context),
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.workflows.start, {
    handle: (input) =>
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine;
        const workflowRun = yield* engine.startWorkflow({
          workflowKey: input.workflowKey,
          variables: input.variables ?? {},
          context: input.context,
        });
        return { workflowRunId: workflowRun.id, workflowKey: workflowRun.workflowKey };
      }),
    mapError: (error, context) => toWorkflowApiError(error, context),
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.workflows.runEvents, {
    handle: (_input, _context, params, query) =>
      Effect.gen(function* () {
        const projection = yield* WorkflowRunProjection;
        const ledger = yield* WorkflowEventLedger;
        const runSummary = yield* projection.getSummary(params.runId);
        if (!runSummary) {
          return yield* workflowRunNotFound(params.runId);
        }
        const includeChildren = booleanQuery(query.includeChildren ?? false);
        const events = yield* ledger.readRunEvents({ runId: params.runId, includeChildren });
        return { runId: params.runId, includeChildren, events: capRecentEvents(events) };
      }),
    mapError: (error, context) => toWorkflowApiError(error, context),
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.workflows.pause, {
    handle: (_input, _context, params) =>
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine;
        return yield* engine.pause({ runId: params.runId });
      }),
    mapError: (error, context) => toWorkflowApiError(error, context),
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.workflows.resume, {
    handle: (_input, _context, params) =>
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine;
        return yield* engine.resume({ runId: params.runId });
      }),
    mapError: (error, context) => toWorkflowApiError(error, context),
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.workflows.clear, {
    handle: (_input, _context, params) =>
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine;
        return yield* engine.clear({ runId: params.runId });
      }),
    mapError: (error, context) => toWorkflowApiError(error, context),
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.workflows.retry, {
    handle: (_input, _context, params) =>
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine;
        return yield* engine.retry({ runId: params.runId });
      }),
    mapError: (error, context) => toWorkflowApiError(error, context),
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.workflows.advance, {
    handle: (input, _context, params) =>
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine;
        const result = yield* engine.advance({ runId: params.runId, answers: input.answers });
        return { runId: result.run.id, status: result.run.status };
      }),
    mapError: (error, context) => toWorkflowApiError(error, context),
    run,
  });

  registerWorkflowEventsStreamRoute(fastify, run);
}

function registerWorkflowEventsStreamRoute(
  fastify: FastifyInstance,
  run: ReturnType<typeof runWithRuntime>,
) {
  fastify.get(
    `${apiBasePath}${workflowEventsStreamWebSocketEndpoint.path}`,
    {
      websocket: true,
      preValidation: (request, reply, done) => {
        const origin = request.headers.origin;
        if (!isAllowedRuntimeOrigin(Array.isArray(origin) ? origin[0] : origin)) {
          reply.code(403).send('Forbidden');
          return;
        }
        done();
      },
    },
    (socket, request) => {
      const runId = decodeRunId(request.params);
      const includeChildren = decodeIncludeChildren(request.query);
      let closed = false;
      let subscribed = false;
      let unsubscribe = () => {};

      const send = (message: WorkflowEventsStreamOutputMessage) => {
        if (socket.readyState !== 1) return false;
        try {
          const encoded = Schema.decodeUnknownSync(workflowEventsStreamOutputMessageSchema)(
            message,
          );
          socket.send(JSON.stringify(encoded));
          return true;
        } catch (error: unknown) {
          console.error('[runtime] Workflow events websocket encoding failed', error);
          socket.close();
          return false;
        }
      };

      socket.once('close', () => {
        closed = true;
        unsubscribe();
      });

      if (runId === null) {
        send({
          type: 'error',
          code: 'workflow_run_not_found',
          message: 'Workflow events stream target was invalid.',
        });
        socket.close();
        return;
      }

      socket.on('message', (raw: Buffer) => {
        const message = decodeStreamClientMessage(raw);
        if (!message) {
          send({ type: 'error', code: 'invalid_message' });
          socket.close();
          return;
        }
        if (subscribed) return;
        subscribed = true;

        void run(
          Effect.gen(function* () {
            const internalBus = yield* InternalRuntimeEventBus;
            const ledger = yield* WorkflowEventLedger;
            const projection = yield* WorkflowRunProjection;
            const runSummary = yield* projection.getSummary(runId);
            if (!runSummary) {
              return yield* workflowRunNotFound(runId);
            }
            const subscription = yield* internalBus.subscribe({
              types: ['workflow_event_appended'],
            });
            const events = yield* ledger.readRunEvents({ runId, includeChildren });
            return { subscription, events, rootRunId: runSummary.rootRunId };
          }).pipe(Effect.either),
        )
          .then((result) => {
            if (closed) return;
            if (Either.isLeft(result)) {
              console.error('[runtime] Workflow events websocket snapshot failed', result.left);
              send({
                type: 'error',
                code: workflowEventsStreamErrorCode(result.left),
                message: errorMessage(result.left),
              });
              socket.close();
              return;
            }

            const { subscription, events, rootRunId } = result.right;
            unsubscribe = () => {
              void run(subscription.unsubscribe).catch((error: unknown) => {
                console.warn('[runtime] Workflow events websocket unsubscribe failed', error);
              });
            };
            if (!send({ type: 'workflow_events_snapshot', events: [...capRecentEvents(events)] }))
              return;

            const pump = (): void => {
              if (closed) return;
              void run(subscription.take.pipe(Effect.either)).then(
                (eventResult) => {
                  if (closed) return;
                  if (Either.isLeft(eventResult)) {
                    console.error(
                      '[runtime] Workflow events websocket receive failed',
                      eventResult.left,
                    );
                    send({
                      type: 'error',
                      code: 'workflow_events_unavailable',
                      message: errorMessage(eventResult.left),
                    });
                    socket.close();
                    return;
                  }
                  const event = eventResult.right;
                  if (
                    event.type === 'workflow_event_appended' &&
                    (includeChildren ? event.rootRunId === rootRunId : event.runId === runId)
                  ) {
                    if (!send({ type: 'workflow_event_appended', event: event.event })) return;
                  }
                  pump();
                },
                (error: unknown) => {
                  if (closed) return;
                  console.error('[runtime] Workflow events websocket failed', error);
                  socket.close();
                },
              );
            };

            pump();
          })
          .catch((error: unknown) => {
            console.error('[runtime] Workflow events websocket failed', error);
            socket.close();
          });
      });
    },
  );
}

function toWorkflowApiError(error: unknown, context: ApiRouteContext): ApiError {
  if (error instanceof WorkflowEngineError) {
    return {
      code: 'workflow_rejected',
      status: error.code === 'workflow_surface_busy' ? 409 : 400,
      message: error.message,
      requestId: context.requestId,
      data: {
        reason: error.code,
        ...(error.workflowKey ? { workflowKey: error.workflowKey } : {}),
        ...(error.workflowLoadFailureReason
          ? { workflowLoadFailureReason: error.workflowLoadFailureReason }
          : {}),
        ...(error.workflowRunId ? { workflowRunId: error.workflowRunId } : {}),
        ...(error.activeWorkflowRunId ? { activeWorkflowRunId: error.activeWorkflowRunId } : {}),
        ...(error.operation ? { operation: error.operation } : {}),
        ...(error.worktreeId ? { worktreeId: error.worktreeId } : {}),
        ...(error.surfaceId ? { surfaceId: error.surfaceId } : {}),
        ...(error.paneId ? { paneId: error.paneId } : {}),
        ...(error.agentSessionId ? { agentSessionId: error.agentSessionId } : {}),
      },
    };
  }

  if (error instanceof DatabaseError) {
    return {
      code: 'runtime_database_failed',
      status: 500,
      message: `Database operation failed: ${error.operation}`,
      requestId: context.requestId,
      data: { operation: error.operation },
    };
  }

  if (error instanceof WorkflowEventLedgerError) {
    return {
      code: 'workflow_rejected',
      status: 500,
      message: `Workflow event ledger failed: ${error.code}`,
      requestId: context.requestId,
      data: {
        reason: 'workflow_event_ledger_failed',
        ...(error.runId ? { workflowRunId: error.runId } : {}),
        ...(error.surfaceId ? { surfaceId: error.surfaceId } : {}),
      },
    };
  }

  console.error(
    `[runtime] Unhandled workflow API handler error during ${context.endpointId}`,
    error,
  );

  return {
    code: 'api_unhandled_error',
    status: 500,
    message: errorMessage(error),
    requestId: context.requestId,
    data: { endpointId: context.endpointId },
  };
}

function workflowRunNotFound(runId: number) {
  return Effect.fail(
    new WorkflowEngineError({
      code: 'workflow_run_not_found',
      message: `Workflow run ${runId} was not found.`,
      workflowRunId: runId,
    }),
  );
}

function workflowEventsStreamErrorCode(error: unknown): WorkflowEventsStreamErrorCode {
  return error instanceof WorkflowEngineError && error.code === 'workflow_run_not_found'
    ? 'workflow_run_not_found'
    : 'workflow_events_unavailable';
}

function decodeRunId(params: unknown) {
  if (!params || typeof params !== 'object' || !('runId' in params)) return null;
  const value = (params as Record<string, unknown>).runId;
  const decoded = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof decoded === 'number' && Number.isInteger(decoded) && decoded > 0 ? decoded : null;
}

function decodeIncludeChildren(query: unknown) {
  if (!query || typeof query !== 'object' || !('includeChildren' in query)) return false;
  return booleanQuery((query as Record<string, unknown>).includeChildren);
}

function booleanQuery(value: unknown): boolean {
  return value === true || value === 'true';
}

function decodeStreamClientMessage(raw: Buffer) {
  try {
    return Schema.decodeUnknownSync(workflowEventsStreamInputMessageSchema)(
      JSON.parse(raw.toString()),
    );
  } catch {
    return null;
  }
}
