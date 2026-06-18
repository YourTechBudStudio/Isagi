import { pathToFileURL } from 'node:url';

import { Effect } from 'effect';

import type { AgentSessionArtifactsService } from '../agent-sessions/index.js';
import { harnessEnvForProcess } from './env.js';
import type { HarnessLaunchContext } from './types.js';

export function buildOpenCodeLaunch(
  input: HarnessLaunchContext,
  dependencies: {
    readonly pluginPath: string;
    readonly artifacts: AgentSessionArtifactsService;
  },
) {
  return Effect.sync(() => {
    const configContent = JSON.stringify({
      plugin: [pathToFileURL(dependencies.pluginPath).toString()],
    });
    console.info('[runtime] OpenCode harness launch envelope prepared', {
      agentSessionId: input.agentSessionId,
      cwd: input.cwd,
      latestHarnessSessionId: input.latestHarnessSessionId,
      pluginPath: dependencies.pluginPath,
    });
    return {
      command: 'opencode',
      args: input.latestHarnessSessionId ? ['--session', input.latestHarnessSessionId] : [],
      cwd: input.cwd,
      envForProcess: ({ ptyProcessId }: { readonly ptyProcessId: number }) =>
        harnessEnvForProcess({
          agentSessionId: input.agentSessionId,
          ptyProcessId,
          artifacts: dependencies.artifacts,
          extraEnv: {
            OPENCODE_CONFIG_CONTENT: configContent,
          },
        }),
    };
  });
}
