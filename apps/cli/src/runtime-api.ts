import { Effect } from 'effect';

import type {
  AnyApiContentEndpoint,
  AnyApiEndpoint,
  ApiEndpointOutput,
  ApiEndpointRequestArgs,
} from '@isagi/contracts';
import { RuntimeClient, type ContentQuery, type RuntimeContent } from '@isagi/runtime-client';

import { CliFailure, fromRuntimeError } from './errors.js';

/*
 * The runtime's HTTP API as the CLI's handlers call it: the shared `RuntimeClient`, with every
 * failure turned into the CLI's error document naming the endpoint it came from. `main.ts` provides
 * the client for the resolved runtime URL; tests provide a fake keyed by endpoint id.
 */

/** One JSON route, with its failure as the CLI's error document. */
export const call = <Endpoint extends AnyApiEndpoint>(
  endpoint: Endpoint,
  ...args: ApiEndpointRequestArgs<Endpoint>
): Effect.Effect<ApiEndpointOutput<Endpoint>, CliFailure, RuntimeClient> =>
  RuntimeClient.use((client) =>
    client
      .request(endpoint, ...args)
      .pipe(
        Effect.mapError((error) =>
          fromRuntimeError(error, { endpointId: endpoint.id, runtimeUrl: client.runtimeUrl }),
        ),
      ),
  );

/** One content route's unread bytes, with its failure as the CLI's error document. */
export const callContent = <Endpoint extends AnyApiContentEndpoint>(
  endpoint: Endpoint,
  params: Readonly<Record<string, string | number>>,
  query?: ContentQuery,
): Effect.Effect<RuntimeContent, CliFailure, RuntimeClient> =>
  RuntimeClient.use((client) =>
    client
      .requestContent(endpoint, params, query)
      .pipe(
        Effect.mapError((error) =>
          fromRuntimeError(error, { endpointId: endpoint.id, runtimeUrl: client.runtimeUrl }),
        ),
      ),
  );
