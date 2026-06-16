import { Context, Data, Effect, Layer } from 'effect';

export class HarnessEventEndpointError extends Data.TaggedError('HarnessEventEndpointError')<{
  readonly message: string;
}> {}

export interface HarnessEventEndpointService {
  readonly setRuntimeUrl: (runtimeUrl: string) => Effect.Effect<void>;
  readonly eventUrl: Effect.Effect<string, HarnessEventEndpointError>;
}

export const HarnessEventEndpoint = Context.GenericTag<HarnessEventEndpointService>(
  'isagi/HarnessEventEndpoint',
);

let runtimeHarnessEventUrl: string | null = null;

export const HarnessEventEndpointLive = Layer.effect(
  HarnessEventEndpoint,
  Effect.sync(
    () =>
      ({
        setRuntimeUrl: (runtimeUrl) =>
          Effect.sync(() => {
            runtimeHarnessEventUrl = new URL('/internal/harness-events', runtimeUrl).toString();
          }),
        eventUrl: Effect.sync(() => runtimeHarnessEventUrl).pipe(
          Effect.flatMap((current) =>
            current
              ? Effect.succeed(current)
              : Effect.fail(
                  new HarnessEventEndpointError({
                    message: 'Harness event endpoint has not been initialized.',
                  }),
                ),
          ),
        ),
      }) satisfies HarnessEventEndpointService,
  ),
);
