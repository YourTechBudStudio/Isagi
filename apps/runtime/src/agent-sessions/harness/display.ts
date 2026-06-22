import type { AgentHarness } from '@isagi/contracts';

export function displayNameForHarness(harness: AgentHarness) {
  switch (harness) {
    case 'opencode':
      return 'OpenCode';
    case 'claude':
      return 'Claude';
    case 'codex':
      return 'Codex';
    case 'pi':
      return 'Pi';
  }
}
