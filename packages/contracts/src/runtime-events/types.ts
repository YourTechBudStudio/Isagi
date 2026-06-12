import { Schema } from 'effect';

import { ptySessionStatusReasonSchema, ptySessionStatusSchema } from '../surfaces/types.js';

const positiveIntegerSchema = Schema.Number.pipe(Schema.int(), Schema.positive());

export const runtimeEventTypeSchema = Schema.Literal('pty_session_changed');

export const runtimeEventBaseSchema = Schema.Struct({
  id: Schema.String.pipe(Schema.minLength(1)),
  type: runtimeEventTypeSchema,
  occurredAt: Schema.String.pipe(Schema.minLength(1)),
});

export const ptySessionChangedEventSchema = Schema.Struct({
  id: Schema.String.pipe(Schema.minLength(1)),
  type: Schema.Literal('pty_session_changed'),
  occurredAt: Schema.String.pipe(Schema.minLength(1)),
  payload: Schema.Struct({
    ptySessionId: positiveIntegerSchema,
    worktreeId: positiveIntegerSchema,
    surfaceId: positiveIntegerSchema,
    paneId: positiveIntegerSchema,
    previousStatus: ptySessionStatusSchema,
    status: ptySessionStatusSchema,
    previousStatusReason: Schema.NullOr(ptySessionStatusReasonSchema),
    statusReason: Schema.NullOr(ptySessionStatusReasonSchema),
  }),
});

export const runtimeEventSchema = Schema.Union(ptySessionChangedEventSchema);

export type RuntimeEventType = Schema.Schema.Type<typeof runtimeEventTypeSchema>;
export type RuntimeEventBase = Schema.Schema.Type<typeof runtimeEventBaseSchema>;
export type PtySessionChangedEvent = Schema.Schema.Type<typeof ptySessionChangedEventSchema>;
export type RuntimeEvent = Schema.Schema.Type<typeof runtimeEventSchema>;
