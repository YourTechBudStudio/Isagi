import { Cause, Data, Effect, Exit, Option, Schema } from 'effect';
import type { FastifyInstance } from 'fastify';

import {
  apiBasePath,
  apiSuccessResponseSchema,
  type AnyApiContentEndpoint,
  type AnyApiEndpoint,
  type ApiEndpointBody,
  type ApiEndpointError,
  type ApiEndpointOutput,
  type ApiEndpointParams,
  type ApiEndpointQuery,
  type ApiError,
  type WireSchema,
} from '@isagi/contracts';

import {
  requestDecodingFailed,
  responseEncodingFailed,
  sendApiError,
  unhandledApiError,
  withRequestId,
  type ApiRouteContext,
} from './errors.js';
import {
  infrastructureRejection,
  isInfrastructureError,
  type InfrastructureErrorFor,
} from './infrastructure-errors.js';
import { coerceRouteParams, runRouteRequest, type RouteRuntime } from './route-runtime.js';

/**
 * Typed API endpoints: a handler's error channel is exactly what its contract can answer with.
 *
 * A handler fails with `ApiRejected` (built by `request.reject`, typed to the endpoint's declared error union) or with
 * a platform infrastructure error whose contract code the endpoint declares. Anything else does not compile: an
 * unmapped domain error, an infrastructure error the endpoint does not declare, or a rejection outside the contract.
 * Modules map their own tagged errors next to the endpoint with `Effect.catchTags`.
 *
 * The request pipeline (`runRoute`) is one Effect that never fails: decode body, params and query; run the handler;
 * turn its exit into the reply. Defects are logged and answered `api_unhandled_error`; a rejection is still checked
 * against the endpoint's error schema at runtime, because schema filters are not type-level.
 */

/** Either descriptor kind: a JSON endpoint or a content endpoint. */
export type AnyRoute = AnyApiEndpoint | AnyApiContentEndpoint;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A contract error minus the request id, which the boundary adds. */
export type Rejection<Endpoint extends AnyRoute> = DistributiveOmit<
  ApiEndpointError<Endpoint>,
  'requestId'
>;

/** A handler's answer that the request was refused, with the contract error to send. */
export class ApiRejected<R> extends Data.TaggedError('ApiRejected')<{ readonly rejection: R }> {}

type ErrorCode<Endpoint> =
  ApiEndpointError<Endpoint> extends { readonly code: infer Code } ? Code : never;

/** The only error channel a handler may have. Anything else fails to compile at the handler. */
export type HandlerError<Endpoint extends AnyRoute> =
  | ApiRejected<Rejection<Endpoint>>
  | InfrastructureErrorFor<ErrorCode<Endpoint>>;

export interface ApiRequest<Endpoint extends AnyRoute> {
  readonly endpointId: string;
  readonly requestId: string;
  readonly body: ApiEndpointBody<Endpoint>;
  readonly params: ApiEndpointParams<Endpoint>;
  readonly query: ApiEndpointQuery<Endpoint>;
  /** Fails the handler with a contract rejection; the type is the endpoint's declared error union. */
  readonly reject: (
    rejection: Rejection<Endpoint>,
  ) => Effect.Effect<never, ApiRejected<Rejection<Endpoint>>>;
}

export type ApiHandler<Endpoint extends AnyRoute, A, R> = (
  request: ApiRequest<Endpoint>,
) => Effect.Effect<A, HandlerError<Endpoint>, R>;

/** The raw request parts the pipeline decodes. */
export interface RouteInput {
  readonly requestId: string;
  readonly body: unknown;
  readonly params: unknown;
  readonly query: unknown;
}

/** What a request pipeline produced: the handler's value, or the error envelope to send instead. */
export type RouteResult<A> =
  | { readonly _tag: 'Succeeded'; readonly value: A }
  | { readonly _tag: 'Failed'; readonly error: ApiError; readonly outcome: 'failed' | 'threw' };

/** A JSON reply ready to send. */
export interface ApiReply {
  readonly status: number;
  readonly body: unknown;
  readonly outcome: 'failed' | 'succeeded' | 'threw';
}

class RequestDecodingFailed extends Data.TaggedError('RequestDecodingFailed')<{
  readonly cause: Schema.SchemaError;
}> {}

const decodePart = (schema: unknown, value: unknown) =>
  schema === undefined
    ? Effect.succeed(undefined)
    : Schema.decodeUnknownEffect(schema as WireSchema)(value).pipe(
        Effect.mapError((cause) => new RequestDecodingFailed({ cause })),
      );

/** The request pipeline shared by JSON and content endpoints. Never fails. */
export function runRoute<Endpoint extends AnyRoute, A, R>(
  endpoint: Endpoint,
  input: RouteInput,
  handle: ApiHandler<Endpoint, A, R>,
): Effect.Effect<RouteResult<A>, never, R> {
  const context: ApiRouteContext = { endpointId: endpoint.id, requestId: input.requestId };
  const program = Effect.gen(function* () {
    const body = yield* decodePart('body' in endpoint ? endpoint.body : undefined, input.body);
    const params = yield* decodePart(endpoint.params, coerceRouteParams(input.params));
    const query = yield* decodePart(endpoint.query, coerceRouteParams(input.query));
    return yield* handle({
      ...context,
      body: body as ApiEndpointBody<Endpoint>,
      params: params as ApiEndpointParams<Endpoint>,
      query: query as ApiEndpointQuery<Endpoint>,
      reject: (rejection) => Effect.fail(new ApiRejected({ rejection })),
    });
  });
  return Effect.flatMap(Effect.exit(program), (exit) => routeResult(endpoint, context, exit));
}

function routeResult<A>(
  endpoint: AnyRoute,
  context: ApiRouteContext,
  exit: Exit.Exit<A, unknown>,
): Effect.Effect<RouteResult<A>> {
  if (Exit.isSuccess(exit)) {
    return Effect.succeed({ _tag: 'Succeeded', value: exit.value });
  }
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isSome(failure)) {
    const error = failure.value;
    if (error instanceof RequestDecodingFailed) {
      return Effect.succeed(failed(requestDecodingFailed(context, error.cause), 'failed'));
    }
    if (error instanceof ApiRejected) {
      return declaredError(
        endpoint,
        context,
        withRequestId(error.rejection as Omit<ApiError, 'requestId'>, context.requestId),
      );
    }
    if (isInfrastructureError(error)) {
      return declaredError(
        endpoint,
        context,
        withRequestId(infrastructureRejection(error), context.requestId),
      );
    }
    // Unreachable for a well-typed handler; answered the way any unexpected failure is.
    return Effect.logError('Unhandled API handler failure', exit.cause).pipe(
      Effect.as(failed(unhandledApiError(context, error), 'threw')),
    );
  }
  if (Cause.hasInterruptsOnly(exit.cause)) {
    return Effect.succeed(failed(unhandledApiError(context, Cause.squash(exit.cause)), 'threw'));
  }
  return Effect.logError('Unhandled API handler failure', exit.cause).pipe(
    Effect.as(failed(unhandledApiError(context, Cause.squash(exit.cause)), 'threw')),
  );
}

const failed = <A>(error: ApiError, outcome: 'failed' | 'threw'): RouteResult<A> => ({
  _tag: 'Failed',
  error,
  outcome,
});

/** A route can never emit a rejection its own contract does not describe. */
function declaredError<A>(
  endpoint: AnyRoute,
  context: ApiRouteContext,
  error: ApiError,
): Effect.Effect<RouteResult<A>> {
  return Schema.decodeUnknownEffect(endpoint.errors as WireSchema)(error).pipe(
    Effect.as(failed<A>(error, 'failed')),
    Effect.catchTag('SchemaError', (cause) =>
      Effect.logError('API error encoding failed', cause.message).pipe(
        Effect.as(failed<A>(responseEncodingFailed(context, cause), 'threw')),
      ),
    ),
  );
}

/** Encodes a handler's output into the success envelope; a mismatch is the runtime's fault and is logged. */
function encodeSuccess(
  schema: WireSchema,
  context: ApiRouteContext,
  output: unknown,
): Effect.Effect<ApiReply> {
  return Schema.encodeUnknownEffect(schema)({
    data: output,
    meta: { requestId: context.requestId },
  }).pipe(
    Effect.map((body): ApiReply => ({ status: 200, body, outcome: 'succeeded' })),
    Effect.catchTag('SchemaError', (cause) => {
      const error = responseEncodingFailed(context, cause);
      return Effect.logError('API response encoding failed', cause.message).pipe(
        Effect.as<ApiReply>({ status: error.status, body: { error }, outcome: 'succeeded' }),
      );
    }),
  );
}

/** The JSON endpoint pipeline: `runRoute`, then the success envelope or the error envelope. Never fails. */
export function runEndpoint<Endpoint extends AnyApiEndpoint, R>(
  endpoint: Endpoint,
  input: RouteInput,
  handle: ApiHandler<Endpoint, ApiEndpointOutput<Endpoint>, R>,
  successSchema: WireSchema = apiSuccessResponseSchema(endpoint.output),
): Effect.Effect<ApiReply, never, R> {
  const context: ApiRouteContext = { endpointId: endpoint.id, requestId: input.requestId };
  return Effect.flatMap(runRoute(endpoint, input, handle), (result) =>
    result._tag === 'Succeeded'
      ? encodeSuccess(successSchema, context, result.value)
      : Effect.succeed<ApiReply>({
          status: result.error.status,
          body: { error: result.error },
          outcome: result.outcome,
        }),
  );
}

/**
 * Registers a JSON endpoint whose handler runs on `runtime`.
 *
 * `R` comes from the runtime, so a handler that needs a service the registrar's runtime does not provide fails to
 * compile at the handler.
 */
export function registerApiEndpoint<Endpoint extends AnyApiEndpoint, R>(
  fastify: FastifyInstance,
  runtime: RouteRuntime<R>,
  endpoint: Endpoint,
  handle: ApiHandler<Endpoint, ApiEndpointOutput<Endpoint>, NoInfer<R>>,
) {
  const successSchema = apiSuccessResponseSchema(endpoint.output);
  fastify.route({
    method: endpoint.method,
    url: `${apiBasePath}${endpoint.path}`,
    handler: async (request, reply) => {
      const context: ApiRouteContext = { endpointId: endpoint.id, requestId: String(request.id) };
      const result = await runRouteRequest(
        runtime,
        request,
        reply,
        context,
        runEndpoint(
          endpoint,
          {
            requestId: context.requestId,
            body: request.body,
            params: request.params,
            query: request.query,
          },
          handle,
          successSchema,
        ),
        (sent) => sent.outcome,
      );
      if (result.clientGone) return;
      if (result._tag === 'Rejected') {
        return sendApiError(reply, unhandledApiError(context, result.cause));
      }
      return reply.status(result.value.status).send(result.value.body);
    },
  });
}
