import { Effect } from 'effect';

import { harnessEnvForProcess } from '../env.js';
import type { AgentSessionArtifactsService } from '../ledger.js';
import type { HarnessHeadlessLaunchContext, HarnessLaunchContext } from '../types.js';

export function buildPiLaunch(
  input: HarnessLaunchContext,
  dependencies: {
    readonly extensionPath: string;
    readonly skillDirectory: string;
    readonly artifacts: AgentSessionArtifactsService;
    readonly runtimeUrl: string;
  },
) {
  return Effect.sync(() => {
    console.info('[runtime] Pi harness launch envelope prepared', {
      agentSessionId: input.agentSessionId,
      cwd: input.cwd,
      latestHarnessSessionId: input.latestHarnessSessionId,
      model: input.model,
      effort: input.effort,
      extensionPath: dependencies.extensionPath,
      skillDirectory: dependencies.skillDirectory,
    });
    return {
      command: 'pi',
      args: [
        ...(input.latestHarnessSessionId ? ['--session', input.latestHarnessSessionId] : []),
        ...(input.model ? ['--model', input.model] : []),
        ...(input.effort ? ['--thinking', input.effort] : []),
        '--skill',
        dependencies.skillDirectory,
        '-e',
        dependencies.extensionPath,
      ],
      cwd: input.cwd,
      launchMode: 'user_shell' as const,
      envForProcess: ({ ptyProcessId }: { readonly ptyProcessId: number }) =>
        harnessEnvForProcess({
          agentSessionId: input.agentSessionId,
          ptyProcessId,
          artifacts: dependencies.artifacts,
          runtimeUrl: dependencies.runtimeUrl,
        }),
    };
  });
}

export function buildPiHeadlessLaunch(input: HarnessHeadlessLaunchContext) {
  return Effect.sync(() => {
    console.info('[runtime] Pi headless launch envelope prepared', {
      cwd: input.cwd,
      model: input.model,
      effort: input.effort,
    });
    return {
      command: 'pi',
      args: [
        '--print',
        '--mode',
        'json',
        '--no-session',
        ...(input.model ? ['--model', input.model] : []),
        ...(input.effort ? ['--thinking', input.effort] : []),
        input.prompt,
      ],
      cwd: input.cwd,
      launchMode: 'user_shell' as const,
    };
  });
}
