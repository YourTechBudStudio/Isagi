import { Layer } from 'effect';

import { InternalEvents } from './internal-events.js';
import { RuntimeEvents } from './runtime-events.js';

/** Both event buses. Services wire them by reference, so this names the same two instances. */
export const EventsLayer = Layer.mergeAll(InternalEvents.layer, RuntimeEvents.layer);
