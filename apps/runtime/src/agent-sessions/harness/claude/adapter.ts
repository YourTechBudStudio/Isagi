import { Effect } from 'effect';

import { harnessEnvForProcess } from '../env.js';
import type { AgentSessionArtifactsService } from '../ledger.js';
import type { HarnessHeadlessLaunchContext, HarnessLaunchContext } from '../types.js';

export function buildClaudeLaunch(
  input: HarnessLaunchContext,
  dependencies: {
    readonly settingsPath: string;
    readonly skillWorkspaceDirectory: string;
    readonly artifacts: AgentSessionArtifactsService;
  },
) {
  return Effect.sync(() => {
    console.info('[runtime] Claude harness launch envelope prepared', {
      agentSessionId: input.agentSessionId,
      cwd: input.cwd,
      latestHarnessSessionId: input.latestHarnessSessionId,
      model: input.model,
      effort: input.effort,
      settingsPath: dependencies.settingsPath,
      skillWorkspaceDirectory: dependencies.skillWorkspaceDirectory,
    });
    return {
      command: 'claude',
      args: [
        ...(input.latestHarnessSessionId ? ['--resume', input.latestHarnessSessionId] : []),
        ...(input.model ? ['--model', input.model] : []),
        ...(input.effort ? ['--effort', input.effort] : []),
        '--add-dir',
        dependencies.skillWorkspaceDirectory,
        '--settings',
        dependencies.settingsPath,
      ],
      cwd: input.cwd,
      launchMode: 'user_shell' as const,
      envForProcess: ({ ptyProcessId }: { readonly ptyProcessId: number }) =>
        harnessEnvForProcess({
          agentSessionId: input.agentSessionId,
          ptyProcessId,
          artifacts: dependencies.artifacts,
        }),
    };
  });
}

export function buildClaudeHeadlessLaunch(input: HarnessHeadlessLaunchContext) {
  return Effect.sync(() => {
    console.info('[runtime] Claude headless launch envelope prepared', {
      cwd: input.cwd,
      model: input.model,
      effort: input.effort,
    });
    return {
      command: 'claude',
      args: [
        '--print',
        '--output-format',
        'json',
        ...(input.model ? ['--model', input.model] : []),
        ...(input.effort ? ['--effort', input.effort] : []),
        input.prompt,
      ],
      cwd: input.cwd,
      launchMode: 'user_shell' as const,
    };
  });
}
