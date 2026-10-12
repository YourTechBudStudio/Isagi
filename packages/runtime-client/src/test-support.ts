// Test-only: a fake runtime behind `FetchHttpClient.Fetch`, so tests see exactly what the requester
// put on the wire without patching `globalThis.fetch`.
import { Effect, Layer, type Scope } from 'effect';
import { FetchHttpClient, type HttpClient } from 'effect/http';

import { RuntimeClient } from './service.js';

export const runtimeUrl = 'http://runtime.test';

export interface SeenRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
  readonly signal: AbortSignal | undefined;
}

export function fakeRuntime(answer: (seen: SeenRequest) => Response | Promise<Response>) {
  const seen: SeenRequest[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const entry: SeenRequest = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: bodyText(init?.body),
      signal: init?.signal ?? undefined,
    };
    seen.push(entry);
    return answer(entry);
  };
  const httpClient = FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  );
  const layer = RuntimeClient.layer(runtimeUrl).pipe(Layer.provideMerge(httpClient));
  return {
    seen,
    run: <A, E>(effect: Effect.Effect<A, E, RuntimeClient | HttpClient.HttpClient | Scope.Scope>) =>
      Effect.runPromise(Effect.scoped(Effect.provide(effect, layer))),
  };
}

export function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}

function bodyText(body: BodyInit | null | undefined): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  throw new Error(`fakeRuntime cannot read a ${Object.prototype.toString.call(body)} body`);
}
