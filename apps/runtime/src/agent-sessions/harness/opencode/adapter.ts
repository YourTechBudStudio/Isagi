import { pathToFileURL } from 'node:url';

import { Effect } from 'effect';

import { harnessEnvForProcess } from '../env.js';
import type { AgentSessionArtifactsService } from '../ledger.js';
import type { HarnessHeadlessLaunchContext, HarnessLaunchContext } from '../types.js';

export function buildOpenCodeLaunch(
  input: HarnessLaunchContext,
  dependencies: {
    readonly pluginPath: string;
    readonly skillScanDirectory: string;
    readonly artifacts: AgentSessionArtifactsService;
    readonly runtimeUrl: string;
  },
) {
  return Effect.sync(() => {
    const configContent = JSON.stringify({
      plugin: [pathToFileURL(dependencies.pluginPath).toString()],
      skills: {
        paths: [dependencies.skillScanDirectory],
      },
    });
    console.info('[runtime] OpenCode harness launch envelope prepared', {
      agentSessionId: input.agentSessionId,
      cwd: input.cwd,
      latestHarnessSessionId: input.latestHarnessSessionId,
      model: input.model,
      effort: input.effort,
      pluginPath: dependencies.pluginPath,
      skillScanDirectory: dependencies.skillScanDirectory,
    });
    return {
      command: 'opencode',
      args: [
        ...(input.latestHarnessSessionId ? ['--session', input.latestHarnessSessionId] : []),
        ...(input.model ? ['--model', input.model] : []),
        ...(input.effort ? ['--variant', input.effort] : []),
      ],
      cwd: input.cwd,
      launchMode: 'user_shell' as const,
      envForProcess: ({ ptyProcessId }: { readonly ptyProcessId: number }) =>
        harnessEnvForProcess({
          agentSessionId: input.agentSessionId,
          ptyProcessId,
          artifacts: dependencies.artifacts,
          runtimeUrl: dependencies.runtimeUrl,
          extraEnv: {
            OPENCODE_CONFIG_CONTENT: configContent,
            // Keep foreground subagents and every other experimental feature
            // available. This narrowly prevents a root session from becoming
            // terminal before an Isagi-unobservable background child completes.
            OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: 'false',
            ...(input.latestHarnessSessionId
              ? { ISAGI_OPENCODE_RESUMED_ROOT_SESSION_ID: input.latestHarnessSessionId }
              : {}),
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
      launchMode: 'user_shell' as const,
    };
  });
}
