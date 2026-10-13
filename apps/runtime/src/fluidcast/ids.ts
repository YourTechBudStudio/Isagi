import { randomUUID } from 'node:crypto';

import type { Brand } from 'effect';

/**
 * One live Fluidcast session, minted by the runtime when it starts. Per-instance routes are keyed by
 * it, so a request meant for a stopped session can never reach its replacement.
 */
export type FluidcastSessionId = string & Brand.Brand<'FluidcastSessionId'>;

export const mintFluidcastSessionId = (): FluidcastSessionId => randomUUID() as FluidcastSessionId;
