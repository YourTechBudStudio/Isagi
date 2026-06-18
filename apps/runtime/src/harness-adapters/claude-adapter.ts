import { Effect } from 'effect';

import type { AgentSessionArtifactsService } from '../agent-sessions/index.js';
import { harnessEnvForProcess } from './env.js';
import type { HarnessLaunchContext } from './types.js';

export function buildClaudeLaunch(
  input: HarnessLaunchContext,
  dependencies: {
    readonly settingsPath: string;
    readonly artifacts: AgentSessionArtifactsService;
  },
) {
  return Effect.sync(() => {
    console.info('[runtime] Claude harness launch envelope prepared', {
      agentSessionId: input.agentSessionId,
      cwd: input.cwd,
      latestHarnessSessionId: input.latestHarnessSessionId,
      settingsPath: dependencies.settingsPath,
    });
    return {
      command: 'claude',
      args: [
        ...(input.latestHarnessSessionId ? ['--resume', input.latestHarnessSessionId] : []),
        '--settings',
        dependencies.settingsPath,
      ],
      cwd: input.cwd,
      envForProcess: ({ ptyProcessId }: { readonly ptyProcessId: number }) =>
        harnessEnvForProcess({
          agentSessionId: input.agentSessionId,
          ptyProcessId,
          artifacts: dependencies.artifacts,
        }),
    };
  });
}
