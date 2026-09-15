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
  RuntimeEventBusLive,
  type RuntimeEventBusService,
  type RuntimeEventSubscription,
} from './event-bus.js';
export {
  InternalRuntimeEventBus,
  InternalRuntimeEventBusLive,
  type InternalRuntimeEvent,
  type InternalRuntimeEventBusService,
  type InternalRuntimeEventSubscription,
} from './internal-event-bus.js';
