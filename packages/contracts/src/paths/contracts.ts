import { oc } from '@orpc/contract';

import { pathSuggestInputSchema, pathSuggestOutputSchema } from './types.js';

export const pathsContract = {
  suggest: oc.input(pathSuggestInputSchema).output(pathSuggestOutputSchema),
};
