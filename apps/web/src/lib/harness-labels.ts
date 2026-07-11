import { Schema } from 'effect';

import { agentHarnessSchema, type AgentHarness } from '@isagi/contracts';

// The one place the web spells harness display names. Runtime facts (which
// harnesses exist, whether they are launchable) come from the control plane;
// these are just the human labels for chrome.
export const HARNESS_LABELS: Record<AgentHarness, string> = {
  pi: 'Pi',
  opencode: 'OpenCode',
  claude: 'Claude',
  codex: 'Codex',
};

export function harnessLabel(harness: AgentHarness): string {
  return HARNESS_LABELS[harness];
}

const isAgentHarness = Schema.is(agentHarnessSchema);

// One shared guard for untrusted select values. Dynamic `options` do not validate
// what actually lands in `ArgValues`, so every command that reads a harness arg
// narrows through this instead of casting.
export function parseAgentHarness(value: string | undefined): AgentHarness | null {
  return value !== undefined && isAgentHarness(value) ? value : null;
}
