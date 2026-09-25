import { Context, Effect, Layer } from 'effect';

import type { ApiEndpointOutput, ApiEndpointRequestArgs } from '@isagi/contracts';
import {
  createEndpointRequester,
  requestContent,
  type AnyApiContentEndpoint,
  type AnyApiEndpoint,
  type EndpointRequester,
  type RuntimeContentEndpointError,
} from '@isagi/runtime-client';

import { CliFailure, fromRuntimeError } from './errors.js';

/**
 * The runtime's HTTP API as the CLI sees it: the shared requester, bound to one runtime URL.
 *
 * A service so tests replace the network with a fake keyed by endpoint id and run the whole CLI in
 * process. Failures stay the shared client's; `call` and `callContent` turn them into the CLI's
 * error document with the endpoint they came from.
 */
export interface RuntimeApiService {
  readonly runtimeUrl: string;
  readonly request: EndpointRequester;
  readonly requestContent: <Endpoint extends AnyApiContentEndpoint>(
    endpoint: Endpoint,
    params: Record<string, string | number>,
  ) => Effect.Effect<Response, RuntimeContentEndpointError<Endpoint>>;
}

export const RuntimeApi = Context.GenericTag<RuntimeApiService>('isagi/cli/RuntimeApi');
export type RuntimeApi = RuntimeApiService;

export function runtimeApiLayer(runtimeUrl: string): Layer.Layer<RuntimeApiService> {
  return Layer.succeed(RuntimeApi, {
    runtimeUrl,
    request: createEndpointRequester(runtimeUrl),
    requestContent: (endpoint, params) => requestContent(runtimeUrl, endpoint, params),
  });
}

/** One JSON route, with its failure as the CLI's error document. */
export function call<Endpoint extends AnyApiEndpoint>(
  endpoint: Endpoint,
  ...args: ApiEndpointRequestArgs<Endpoint>
): Effect.Effect<ApiEndpointOutput<Endpoint>, CliFailure, RuntimeApiService> {
  return Effect.flatMap(RuntimeApi, (api) =>
    api
      .request(endpoint, ...args)
      .pipe(
        Effect.mapError((error) =>
          fromRuntimeError(error, { endpointId: endpoint.id, runtimeUrl: api.runtimeUrl }),
        ),
      ),
  );
}

/** One content route's unread response, with its failure as the CLI's error document. */
export function callContent<Endpoint extends AnyApiContentEndpoint>(
  endpoint: Endpoint,
  params: Record<string, string | number>,
): Effect.Effect<Response, CliFailure, RuntimeApiService> {
  return Effect.flatMap(RuntimeApi, (api) =>
    api
      .requestContent(endpoint, params)
      .pipe(
        Effect.mapError((error) =>
          fromRuntimeError(error, { endpointId: endpoint.id, runtimeUrl: api.runtimeUrl }),
        ),
      ),
  );
}
