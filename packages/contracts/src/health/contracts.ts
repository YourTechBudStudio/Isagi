import { oc } from '@orpc/contract';

import { healthOutputSchema } from './types.js';

export const healthContract = oc.output(healthOutputSchema);
