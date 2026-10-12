/**
 * The runtime's two event buses and their layer: `RuntimeEvents` (the public, contract-shaped events the
 * `runtime-events` module's socket forwards to clients) and `InternalEvents` (in-process facts one module reacts to
 * after another acted). Publishers and subscribers import only this barrel; the socket route that serves
 * `RuntimeEvents` belongs to the `runtime-events` module (`runtime-events/api.ts`), not to the platform.
 */
export { nextRuntimeEventEnvelope, RuntimeEvents } from './runtime-events.js';
export { InternalEvents, type InternalEvent, type InternalEventOf } from './internal-events.js';
export { EventsLayer } from './layer.js';
