import type { AgentHarness } from '@isagi/contracts';

import { claudeHarnessDefinition } from './claude/definition.js';
import { codexHarnessDefinition } from './codex/definition.js';
import type { HarnessDefinition } from './definition-types.js';
import { openCodeHarnessDefinition } from './opencode/definition.js';
import { piHarnessDefinition } from './pi/definition.js';

export const harnessDefinitions = {
  pi: piHarnessDefinition,
  opencode: openCodeHarnessDefinition,
  claude: claudeHarnessDefinition,
  codex: codexHarnessDefinition,
} satisfies Record<AgentHarness, HarnessDefinition>;

export const supportedHarnesses = Object.keys(harnessDefinitions) as readonly AgentHarness[];

export function harnessDefinition(harness: AgentHarness): HarnessDefinition {
  return harnessDefinitions[harness];
}
