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

/** The harnesses an SDK worker can drive: exactly those whose definition declares `launch.sdk`. */
export type SdkHarness = {
  [H in AgentHarness]: (typeof harnessDefinitions)[H]['launch'] extends { readonly sdk: unknown }
    ? H
    : never;
}[AgentHarness];

export function harnessDefinition(harness: AgentHarness): HarnessDefinition {
  return harnessDefinitions[harness];
}
