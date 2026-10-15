import { pathToFileURL } from 'node:url';

import { Effect } from 'effect';

import { harnessEnvForProcess } from '../env.js';
import type { AgentSessionArtifacts } from '../ledger.js';
import type { HarnessHeadlessLaunchContext, HarnessLaunchContext } from '../types.js';

export const buildOpenCodeLaunch = Effect.fn('harnesses.buildOpenCodeLaunch')(function* (
  input: HarnessLaunchContext,
  dependencies: {
    readonly pluginPath: string;
    readonly artifacts: AgentSessionArtifacts['Service'];
  },
) {
  const configContent = JSON.stringify({
    plugin: [pathToFileURL(dependencies.pluginPath).toString()],
  });
  yield* Effect.logInfo('OpenCode harness launch envelope prepared').pipe(
    Effect.annotateLogs({
      agentSessionId: input.agentSessionId,
      cwd: input.cwd,
      latestHarnessSessionId: input.latestHarnessSessionId,
      model: input.model,
      effort: input.effort,
      pluginPath: dependencies.pluginPath,
    }),
  );
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
        incarnation: { kind: 'pty', ptyProcessId },
        artifacts: dependencies.artifacts,
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

export const buildOpenCodeHeadlessLaunch = Effect.fn('harnesses.buildOpenCodeHeadlessLaunch')(
  function* (input: HarnessHeadlessLaunchContext) {
    yield* Effect.logInfo('OpenCode headless launch envelope prepared').pipe(
      Effect.annotateLogs({
        cwd: input.cwd,
        model: input.model,
        effort: input.effort,
      }),
    );
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
  },
);
