import { pathToFileURL } from 'node:url';

import { Effect } from 'effect';

import { harnessEnvForProcess } from '../env.js';
import type { AgentSessionArtifactsService } from '../ledger.js';
import type { HarnessHeadlessLaunchContext, HarnessLaunchContext } from '../types.js';

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

export function buildOpenCodeHeadlessLaunch(input: HarnessHeadlessLaunchContext) {
  return Effect.sync(() => {
    console.info('[runtime] OpenCode headless launch envelope prepared', {
      cwd: input.cwd,
      model: input.model,
      effort: input.effort,
    });
    return {
      command: 'opencode',
      args: [
        'run',
        '--format',
        'json',
        '--dir',
        input.cwd,
        ...(input.model ? ['--model', input.model] : []),
        ...(input.effort ? ['--variant', input.effort] : []),
        input.prompt,
      ],
      cwd: input.cwd,
    };
  });
}
