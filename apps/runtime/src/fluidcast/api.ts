import { audioMimeType } from '@yourtechbudstudio/fluidcast-core/speech';
import {
  Command,
  CommandRejected,
  SubscriptionMessage,
  ToolCommandRejected,
} from '@yourtechbudstudio/fluidcast-harness/protocol';
import {
  Skill,
  TranscriptMessage,
  WorkerSummary,
} from '@yourtechbudstudio/fluidcast-tool-agent/schema';
import { Effect, Schema, Stream } from 'effect';
import type { FastifyInstance } from 'fastify';

import {
  fluidcastContentEndpoints,
  fluidcastEndpoints,
  fluidcastEventStreamEndpoints,
} from '@isagi/contracts';

import {
  registerApiEndpoint,
  registerEventStreamEndpoint,
  registerStreamingContentEndpoint,
  type RouteRuntime,
} from '../platform/http/index.js';
import { FluidcastSessionNotFound } from './errors.js';
import { FluidcastSessions, type LiveFluidcastSession } from './sessions.service.js';

/**
 * One live session's routes, addressed by its `fluidcastSessionId`. Every handler starts by
 * looking the session up, so a request for a stopped session, such as a late Pause from a pane
 * that has since been switched back and forth, is refused instead of reaching the replacement.
 *
 * Payloads are encoded and decoded with the Fluidcast SDK's own schemas; contracts keep them opaque.
 */
export function registerFluidcastRoutes(
  fastify: FastifyInstance,
  runtime: RouteRuntime<FluidcastSessions>,
) {
  registerEventStreamEndpoint(fastify, runtime, fluidcastEventStreamEndpoints.events, (request) =>
    Effect.map(liveSession(request), (live) =>
      sessionStream(live, live.session.subscribe(), SubscriptionMessage),
    ),
  );
  registerEventStreamEndpoint(
    fastify,
    runtime,
    fluidcastEventStreamEndpoints.workerStatus,
    (request) =>
      Effect.map(liveSession(request), (live) =>
        sessionStream(live, live.worker.status, WorkerSummary),
      ),
  );
  registerEventStreamEndpoint(
    fastify,
    runtime,
    fluidcastEventStreamEndpoints.workerTranscript,
    (request) =>
      Effect.map(liveSession(request), (live) =>
        sessionStream(live, live.worker.transcript, TranscriptMessage),
      ),
  );

  // Listed once per session and bounded by the SDK, which also logs why a listing failed.
  registerApiEndpoint(fastify, runtime, fluidcastEndpoints.workerSkills, (request) =>
    Effect.gen(function* () {
      const live = yield* liveSession(request);
      const skills = yield* live.worker.skills.pipe(
        // Stopped while the skills were listed.
        Effect.raceFirst(
          Effect.andThen(
            live.ended,
            Effect.fail(
              new FluidcastSessionNotFound({ fluidcastSessionId: live.fluidcastSessionId }),
            ),
          ),
        ),
        Effect.catchTags({
          SkillsUnavailable: (error) =>
            request.reject({
              code: 'fluidcast_skills_unavailable',
              status: 502,
              message: "The worker's skills could not be listed.",
              data: { reason: error.reason },
            }),
          FluidcastSessionNotFound: (error) => request.reject(sessionNotFound(error)),
        }),
      );
      return yield* Effect.orDie(Schema.encodeUnknownEffect(Schema.Array(Skill))(skills));
    }),
  );

  registerApiEndpoint(fastify, runtime, fluidcastEndpoints.command, (request) =>
    Effect.gen(function* () {
      const live = yield* liveSession(request);
      const command = yield* Schema.decodeUnknownEffect(Command)(request.body).pipe(
        Effect.catchTag('SchemaError', () =>
          request.reject({
            code: 'fluidcast_command_invalid',
            status: 400,
            message: 'The request body is not a Fluidcast command.',
          }),
        ),
      );
      yield* live.command(command).pipe(
        Effect.catchTags({
          CommandRejected: (error) =>
            Effect.flatMap(Schema.encodeUnknownEffect(CommandRejected)(error), (rejection) =>
              request.reject(commandRejected(rejection)),
            ),
          ToolCommandRejected: (error) =>
            Effect.flatMap(Schema.encodeUnknownEffect(ToolCommandRejected)(error), (rejection) =>
              request.reject(commandRejected(rejection)),
            ),
        }),
        // Stopped while the command ran.
        Effect.catchTag('FluidcastSessionNotFound', (error) =>
          request.reject(sessionNotFound(error)),
        ),
        // Re-encoding the SDK's own error cannot fail short of an SDK defect.
        Effect.catchTag('SchemaError', Effect.die),
      );
      return null;
    }),
  );

  registerStreamingContentEndpoint(
    fastify,
    runtime,
    fluidcastContentEndpoints.speech,
    (request) =>
      Effect.map(liveSession(request), (live) => ({
        mediaType: audioMimeType[live.speechFormat],
        // Not bounded by the session's end: a clip already playing finishes or fails on its own.
        stream: live.session.speech(request.params.actionId),
      })),
    {
      beforeFirstChunk: (error) =>
        error._tag === 'SpeechNotFound'
          ? ({
              code: 'fluidcast_speech_not_found',
              status: 404,
              message: 'The session has no speech for this action.',
            } as const)
          : ({
              code: 'fluidcast_speech_failed',
              status: 502,
              message: 'Speech synthesis failed.',
              data: { reason: error.reason },
            } as const),
    },
  );
}

/** The live session a per-instance request names, or that request's 404. */
function liveSession<E>(request: {
  readonly params: { readonly fluidcastSessionId: string };
  readonly reject: (rejection: ReturnType<typeof sessionNotFound>) => Effect.Effect<never, E>;
}) {
  return FluidcastSessions.use((sessions) =>
    sessions.current(request.params.fluidcastSessionId),
  ).pipe(
    Effect.catchTag('FluidcastSessionNotFound', (error) => request.reject(sessionNotFound(error))),
  );
}

function sessionNotFound(error: FluidcastSessionNotFound) {
  return {
    code: 'fluidcast_session_not_found',
    status: 404,
    message: 'No live Fluidcast session has this ID.',
    data: { fluidcastSessionId: error.fluidcastSessionId },
  } as const;
}

/** A per-instance stream, encoded with the SDK's schema and ended when the session stops. */
function sessionStream<A>(
  live: LiveFluidcastSession,
  stream: Stream.Stream<A>,
  schema: Schema.Codec<A, unknown>,
): Stream.Stream<unknown> {
  return stream.pipe(
    Stream.mapEffect((item) => Effect.orDie(Schema.encodeUnknownEffect(schema)(item))),
    Stream.interruptWhen(live.ended),
  );
}

function commandRejected(rejection: unknown) {
  return {
    code: 'fluidcast_command_rejected',
    status: 409,
    message: 'The session refused the command.',
    data: { rejection },
  } as const;
}
