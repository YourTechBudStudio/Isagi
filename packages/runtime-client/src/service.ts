import { Context, Layer } from 'effect';
import { FetchHttpClient, type HttpClient } from 'effect/http';

import {
  makeRequesters,
  type ContentRequester,
  type EndpointRequester,
  type EventStreamRequester,
} from './requester.js';

/**
 * The platform `fetch` as an `HttpClient`. Provide it once at a process boundary.
 *
 * `fetch` is looked up on `globalThis` per request. `FetchHttpClient.Fetch` otherwise caches
 * `globalThis.fetch` on first use, which would silently ignore the per-test `globalThis.fetch`
 * stubs the web tests and browser fixtures install.
 */
export const RuntimeHttpClient: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer.pipe(
  Layer.provide(
    Layer.succeed(FetchHttpClient.Fetch, (input: RequestInfo | URL, init?: RequestInit) =>
      globalThis.fetch(input, init),
    ),
  ),
);

/**
 * The runtime API bound to one runtime URL. Clients provide it once at their boundary and call
 * `request` / `requestContent`.
 */
export class RuntimeClient extends Context.Service<
  RuntimeClient,
  {
    readonly runtimeUrl: string;
    readonly request: EndpointRequester;
    readonly requestContent: ContentRequester;
    readonly requestEventStream: EventStreamRequester;
  }
>()('isagi/runtime-client/RuntimeClient') {
  /** A client value for a URL known only at run time (desktop health checks, a re-resolved web URL). */
  static readonly make = makeRequesters;
  /**
   * Requires `HttpClient`: the composition root provides `RuntimeHttpClient`; tests provide
   * `FetchHttpClient.layer` with a fake `FetchHttpClient.Fetch`.
   */
  static readonly layer = (runtimeUrl: string) =>
    Layer.effect(RuntimeClient, makeRequesters(runtimeUrl));
}
