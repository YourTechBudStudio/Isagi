import { Schema } from 'effect';

import type {
  ApiContentEndpoint,
  ApiEndpoint,
  ApiEventStreamEndpoint,
  WireSchema,
} from '../api/types.js';
import {
  fluidcastCommandApiErrorSchema,
  fluidcastSessionRouteParamsSchema,
  fluidcastSkillsApiErrorSchema,
  fluidcastSpeechApiErrorSchema,
  fluidcastSpeechRouteParamsSchema,
  fluidcastStreamApiErrorSchema,
} from './types.js';

/**
 * One live Fluidcast session's routes, addressed by its runtime-minted ID. They are three
 * descriptor kinds, so each lives in its own collection and none is part of `apiEndpoints`.
 */

/** JSON routes. */
export const fluidcastEndpoints = {
  /** One player command (the SDK's `Command`). */
  command: {
    id: 'fluidcast.command',
    method: 'POST',
    path: '/fluidcast-sessions/:fluidcastSessionId/commands',
    params: fluidcastSessionRouteParamsSchema,
    body: Schema.Unknown,
    output: Schema.Null,
    errors: fluidcastCommandApiErrorSchema,
  },
  /** The worker's skills (the SDK's `Skill` array), listed once per session by the SDK. */
  workerSkills: {
    id: 'fluidcast.workerSkills',
    method: 'GET',
    path: '/fluidcast-sessions/:fluidcastSessionId/worker/skills',
    params: fluidcastSessionRouteParamsSchema,
    output: Schema.Unknown,
    errors: fluidcastSkillsApiErrorSchema,
  },
} as const satisfies Record<string, ApiEndpoint<WireSchema, WireSchema, WireSchema, WireSchema>>;

/** Server-sent event streams; each ends when the session stops. */
export const fluidcastEventStreamEndpoints = {
  /** The session's `SubscriptionMessage`s: a snapshot, then events. */
  events: {
    id: 'fluidcast.events',
    method: 'GET',
    path: '/fluidcast-sessions/:fluidcastSessionId/events',
    params: fluidcastSessionRouteParamsSchema,
    errors: fluidcastStreamApiErrorSchema,
  },
  /** The worker's `WorkerSummary`s. */
  workerStatus: {
    id: 'fluidcast.workerStatus',
    method: 'GET',
    path: '/fluidcast-sessions/:fluidcastSessionId/worker/status',
    params: fluidcastSessionRouteParamsSchema,
    errors: fluidcastStreamApiErrorSchema,
  },
  /** The worker's `TranscriptMessage`s: a snapshot, then appended entries. */
  workerTranscript: {
    id: 'fluidcast.workerTranscript',
    method: 'GET',
    path: '/fluidcast-sessions/:fluidcastSessionId/worker/transcript',
    params: fluidcastSessionRouteParamsSchema,
    errors: fluidcastStreamApiErrorSchema,
  },
} as const satisfies Record<string, ApiEventStreamEndpoint<WireSchema, WireSchema>>;

/** Byte routes. */
export const fluidcastContentEndpoints = {
  /** One speak line's audio, streamed as it is synthesized, with no declared length. */
  speech: {
    id: 'fluidcast.speech',
    method: 'GET',
    path: '/fluidcast-sessions/:fluidcastSessionId/speech/:actionId',
    params: fluidcastSpeechRouteParamsSchema,
    errors: fluidcastSpeechApiErrorSchema,
  },
} as const satisfies Record<string, ApiContentEndpoint<WireSchema, WireSchema>>;
