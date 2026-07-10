import type { AgentHarness } from '@isagi/contracts';

import { harnessDefinition } from './definitions.js';

export function displayNameForHarness(harness: AgentHarness) {
  return harnessDefinition(harness).displayName;
}
