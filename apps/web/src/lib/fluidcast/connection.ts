import { Transport } from '@yourtechbudstudio/fluidcast-client';
import { WorkerFeed, type FluidcastPlayerProps } from '@yourtechbudstudio/fluidcast-react';
import { Layer, type Effect } from 'effect';

import { RuntimeClient, RuntimeHttpClient } from '@isagi/runtime-client';

import { fluidcastTransport, fluidcastWorkerStreams } from './transport.js';

/** What the player takes; the SDK does not export the alias itself. */
export type PlayerConnection = FluidcastPlayerProps['connection'];

export interface FluidcastConnectionInput {
  /** Resolved before the player renders, so the layer cannot fail. */
  readonly runtimeUrl: string;
  readonly fluidcastSessionId: string;
  /** `PendingPauses.settled(id)`: bounded, never fails. */
  readonly beforeSubscribe: Effect.Effect<void>;
}

/**
 * One Fluidcast session's player connection over its runtime routes. The player treats a new
 * connection object as a new instance, so callers memoize it on the session identity.
 */
export const fluidcastConnection = (input: FluidcastConnectionInput): PlayerConnection =>
  Layer.mergeAll(
    Layer.effect(Transport, fluidcastTransport(input)),
    Layer.effect(WorkerFeed, fluidcastWorkerStreams(input)),
  ).pipe(Layer.provide(RuntimeClient.layer(input.runtimeUrl)), Layer.provide(RuntimeHttpClient));
