import { join } from 'node:path';

import type { AgentHarness } from '@isagi/contracts';

import type { ApprovedHostEnvironment, HarnessDocsTargetResolution } from './definition-types.js';

export function resolveDocsTarget(input: {
  readonly harness: AgentHarness;
  readonly environment: ApprovedHostEnvironment;
  readonly configuredRoot: keyof Pick<
    ApprovedHostEnvironment,
    'PI_CODING_AGENT_DIR' | 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME'
  >;
  readonly defaultSegments: readonly string[];
  readonly targetSegments: readonly string[];
}): HarnessDocsTargetResolution {
  const configuredRoot = input.environment[input.configuredRoot];
  if (configuredRoot) {
    return { _tag: 'Resolved', path: join(configuredRoot, ...input.targetSegments) };
  }
  const home = input.environment.HOME;
  if (!home) return { _tag: 'MissingEnvironmentRoot', harness: input.harness, required: 'HOME' };
  return {
    _tag: 'Resolved',
    path: join(home, ...input.defaultSegments, ...input.targetSegments),
  };
}

export function resolveOpenCodeDocsTarget(
  environment: ApprovedHostEnvironment,
): HarnessDocsTargetResolution {
  const configuredRoot = environment.OPENCODE_CONFIG_DIR;
  if (configuredRoot) {
    return { _tag: 'Resolved', path: join(configuredRoot, 'commands', 'isagi-docs.md') };
  }
  const configRoot = environment.XDG_CONFIG_HOME;
  if (configRoot) {
    return {
      _tag: 'Resolved',
      path: join(configRoot, 'opencode', 'commands', 'isagi-docs.md'),
    };
  }
  const home = environment.HOME;
  if (!home) return { _tag: 'MissingEnvironmentRoot', harness: 'opencode', required: 'HOME' };
  return {
    _tag: 'Resolved',
    path: join(home, '.config', 'opencode', 'commands', 'isagi-docs.md'),
  };
}
