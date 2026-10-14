import { TransportError, type Transport } from '@yourtechbudstudio/fluidcast-client';
import { SpeechError } from '@yourtechbudstudio/fluidcast-core/speech';
import {
  Command,
  CommandRejected,
  SpeechNotFound,
  SubscriptionMessage,
  ToolCommandRejected,
} from '@yourtechbudstudio/fluidcast-harness/protocol';
import { TranscriptMessage, WorkerSummary } from '@yourtechbudstudio/fluidcast-tool-agent/schema';
import { Effect, Schema, Stream } from 'effect';

import {
  fluidcastContentEndpoints,
  fluidcastEndpoints,
  fluidcastEventStreamEndpoints,
} from '@isagi/contracts';
import {
  contentEndpointUrl,
  RuntimeApiError,
  RuntimeClient,
  RuntimeDecodeError,
  RuntimeTransportError,
} from '@isagi/runtime-client';

// The Fluidcast SDK's `Transport` and worker feed over one session's runtime routes. Never imports
// the React package, so it runs under plain `tsx` tests.

export interface FluidcastTransportInput {
  readonly fluidcastSessionId: string;
  /** Runs before every subscription opens: the session's pending hide pauses, bounded. */
  readonly beforeSubscribe: Effect.Effect<void>;
}

/** The `WorkerFeed` service shape, spelled out so this module stays free of the React package. */
export interface FluidcastWorkerStreams {
  readonly status: () => Stream.Stream<WorkerSummary, TransportError>;
  readonly transcript: () => Stream.Stream<TranscriptMessage, TransportError>;
}

type RuntimeFailure = RuntimeApiError | RuntimeTransportError | RuntimeDecodeError;

/** A status with no failure the SDK knows: the class of status is all there is. */
const fromStatus = (status: number) =>
  new TransportError({
    reason: status >= 500 ? 'ServerError' : 'BadRequest',
    status,
  });

/**
 * Isagi's runtime failures in the SDK's transport terms. A stopped or replaced session is the
 * SDK's `BadRequest` at 404, as the reference transport reports a discarded session.
 */
const toTransportError = (error: RuntimeFailure | Schema.SchemaError): TransportError => {
  if (error instanceof RuntimeTransportError) return new TransportError({ reason: 'Unreachable' });
  if (error instanceof RuntimeApiError) return fromStatus(error.apiError.status);
  return new TransportError({ reason: 'Malformed' });
};

const decodeRejection = Schema.decodeUnknownEffect(
  Schema.Union([CommandRejected, ToolCommandRejected]),
);
const decodeSubscriptionMessage = Schema.decodeUnknownEffect(SubscriptionMessage);
const decodeWorkerSummary = Schema.decodeUnknownEffect(WorkerSummary);
const decodeTranscriptMessage = Schema.decodeUnknownEffect(TranscriptMessage);
const encodeCommand = Schema.encodeUnknownEffect(Command);

const sessionStream = <A>(
  client: RuntimeClient['Service'],
  endpoint: (typeof fluidcastEventStreamEndpoints)[keyof typeof fluidcastEventStreamEndpoints],
  fluidcastSessionId: string,
  decode: (value: unknown) => Effect.Effect<A, Schema.SchemaError>,
): Stream.Stream<A, TransportError> =>
  client
    .requestEventStream(endpoint, { fluidcastSessionId })
    .pipe(Stream.mapEffect(decode), Stream.mapError(toTransportError));

export const fluidcastTransport = (
  input: FluidcastTransportInput,
): Effect.Effect<Transport['Service'], never, RuntimeClient> =>
  Effect.gen(function* () {
    const client = yield* RuntimeClient;
    const { fluidcastSessionId } = input;
    const speechParams = (actionId: string) => ({
      fluidcastSessionId,
      actionId,
    });

    return {
      subscribe: () =>
        Stream.unwrap(
          input.beforeSubscribe.pipe(
            Effect.as(
              sessionStream(
                client,
                fluidcastEventStreamEndpoints.events,
                fluidcastSessionId,
                decodeSubscriptionMessage,
              ),
            ),
          ),
        ),

      send: (command) =>
        encodeCommand(command).pipe(
          Effect.mapError(() => new TransportError({ reason: 'BadRequest' })),
          Effect.flatMap((encoded) =>
            client.request(fluidcastEndpoints.command, { fluidcastSessionId }, encoded).pipe(
              Effect.asVoid,
              Effect.catch((error) =>
                error instanceof RuntimeApiError &&
                error.apiError.code === 'fluidcast_command_rejected'
                  ? decodeRejection(error.apiError.data.rejection).pipe(
                      Effect.mapError(() => new TransportError({ reason: 'Malformed' })),
                      Effect.flatMap(Effect.fail),
                    )
                  : Effect.fail(toTransportError(error)),
              ),
            ),
          ),
        ),

      speech: (actionId) =>
        Stream.unwrap(
          client
            .requestContent(fluidcastContentEndpoints.speech, speechParams(actionId))
            .pipe(Effect.map((content) => content.stream)),
        ).pipe(
          Stream.mapError((error) => {
            if (error instanceof RuntimeApiError) {
              if (error.apiError.code === 'fluidcast_speech_not_found') {
                return new SpeechNotFound({ actionId });
              }
              if (error.apiError.code === 'fluidcast_speech_failed') {
                return new SpeechError({ reason: error.apiError.data.reason });
              }
            }
            return toTransportError(error);
          }),
        ),

      speechUrl: (actionId) =>
        contentEndpointUrl(
          client.runtimeUrl,
          fluidcastContentEndpoints.speech,
          speechParams(actionId),
        ),
    } satisfies Transport['Service'];
  });

export const fluidcastWorkerStreams = (
  input: Pick<FluidcastTransportInput, 'fluidcastSessionId'>,
): Effect.Effect<FluidcastWorkerStreams, never, RuntimeClient> =>
  Effect.gen(function* () {
    const client = yield* RuntimeClient;
    return {
      status: () =>
        sessionStream(
          client,
          fluidcastEventStreamEndpoints.workerStatus,
          input.fluidcastSessionId,
          decodeWorkerSummary,
        ),
      transcript: () =>
        sessionStream(
          client,
          fluidcastEventStreamEndpoints.workerTranscript,
          input.fluidcastSessionId,
          decodeTranscriptMessage,
        ),
    };
  });
