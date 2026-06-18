import { Effect } from 'effect';

import type { AgentSessionArtifactsService } from '../agent-sessions/index.js';
import { harnessEnvForProcess } from './env.js';
import type { HarnessLaunchContext } from './types.js';

export function buildPiLaunch(
  input: HarnessLaunchContext,
  dependencies: {
    readonly extensionPath: string;
    readonly artifacts: AgentSessionArtifactsService;
  },
) {
  return Effect.sync(() => {
    console.info('[runtime] Pi harness launch envelope prepared', {
      agentSessionId: input.agentSessionId,
      cwd: input.cwd,
      latestHarnessSessionId: input.latestHarnessSessionId,
      extensionPath: dependencies.extensionPath,
    });
    return {
      command: 'pi',
      args: [
        ...(input.latestHarnessSessionId ? ['--session', input.latestHarnessSessionId] : []),
        '-e',
        dependencies.extensionPath,
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
