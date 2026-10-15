import { Schema } from 'effect';

import { apiInfrastructureErrorSchema } from '../api/responses.js';

/**
 * Fluidcast session payloads (commands, subscription messages, worker summaries and transcripts)
 * are the Fluidcast SDK's own protocol. They stay opaque here and are decoded with the SDK's
 * schemas at either end.
 */

export const fluidcastSessionRouteParamsSchema = Schema.Struct({
  fluidcastSessionId: Schema.String,
});

export const fluidcastSpeechRouteParamsSchema = Schema.Struct({
  fluidcastSessionId: Schema.String,
  actionId: Schema.String,
});

const errorEnvelopeFields = { message: Schema.String, requestId: Schema.String } as const;

/** The session is unknown or stopped: a request meant for an earlier session never reaches a replacement. */
export const fluidcastSessionNotFoundErrorSchema = Schema.Struct({
  code: Schema.Literal('fluidcast_session_not_found'),
  status: Schema.Literal(404),
  ...errorEnvelopeFields,
  data: Schema.Struct({ fluidcastSessionId: Schema.String }),
});

/** The body is not a Fluidcast command. */
export const fluidcastCommandInvalidErrorSchema = Schema.Struct({
  code: Schema.Literal('fluidcast_command_invalid'),
  status: Schema.Literal(400),
  ...errorEnvelopeFields,
});

/** The session refused the command; `rejection` is the SDK-encoded `CommandRejected` or `ToolCommandRejected`. */
export const fluidcastCommandRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('fluidcast_command_rejected'),
  status: Schema.Literal(409),
  ...errorEnvelopeFields,
  data: Schema.Struct({ rejection: Schema.Unknown }),
});

/** The action is not a speak line the session currently holds. */
export const fluidcastSpeechNotFoundErrorSchema = Schema.Struct({
  code: Schema.Literal('fluidcast_speech_not_found'),
  status: Schema.Literal(404),
  ...errorEnvelopeFields,
});

/** The speech service failed before the first byte; `reason` is the SDK's failure tag. */
export const fluidcastSpeechFailedErrorSchema = Schema.Struct({
  code: Schema.Literal('fluidcast_speech_failed'),
  status: Schema.Literal(502),
  ...errorEnvelopeFields,
  data: Schema.Struct({ reason: Schema.String }),
});

export const fluidcastStreamApiErrorSchema = Schema.Union([
  apiInfrastructureErrorSchema,
  fluidcastSessionNotFoundErrorSchema,
]);

export const fluidcastCommandApiErrorSchema = Schema.Union([
  apiInfrastructureErrorSchema,
  fluidcastSessionNotFoundErrorSchema,
  fluidcastCommandInvalidErrorSchema,
  fluidcastCommandRejectedErrorSchema,
]);

export const fluidcastSpeechApiErrorSchema = Schema.Union([
  apiInfrastructureErrorSchema,
  fluidcastSessionNotFoundErrorSchema,
  fluidcastSpeechNotFoundErrorSchema,
  fluidcastSpeechFailedErrorSchema,
]);

export type FluidcastSessionRouteParams = typeof fluidcastSessionRouteParamsSchema.Type;
export type FluidcastSpeechRouteParams = typeof fluidcastSpeechRouteParamsSchema.Type;
