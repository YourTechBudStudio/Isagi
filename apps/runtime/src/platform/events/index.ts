/**
 * The event *buses*, and nothing else.
 *
 * Almost every consumer here wants only a bus, and re-exporting the HTTP route registrar from the
 * same barrel coupled all of them to the API layer and everything it composes. That made a break in
 * an unrelated feature's read model able to stop a PTY or surface test from loading at all — a
 * failure with no relationship to what those tests assert. The two API-layer entry points are
 * imported from their own modules by the two files that compose them.
 */
export {
  nextRuntimeEventEnvelope,
  RuntimeEventBus,
  type RuntimeEventSubscription,
} from './runtime-events.js';
export {
  InternalRuntimeEventBus,
  type InternalRuntimeEvent,
  type InternalRuntimeEventSubscription,
} from './internal-events.js';
