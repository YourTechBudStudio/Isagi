import { Effect } from 'effect';

import { harnessEnvForProcess } from '../env.js';
import type { AgentSessionArtifacts } from '../ledger.js';
import type {
  HarnessHeadlessLaunchContext,
  HarnessLaunchContext,
  SdkInstrumentation,
} from '../types.js';

export const buildClaudeLaunch = Effect.fn('harnesses.buildClaudeLaunch')(function* (
  input: HarnessLaunchContext,
  dependencies: {
    readonly settingsPath: string;
    readonly artifacts: AgentSessionArtifacts['Service'];
  },
) {
  yield* Effect.logInfo('Claude harness launch envelope prepared').pipe(
    Effect.annotateLogs({
      agentSessionId: input.agentSessionId,
      cwd: input.cwd,
      latestHarnessSessionId: input.latestHarnessSessionId,
      model: input.model,
      effort: input.effort,
      settingsPath: dependencies.settingsPath,
    }),
  );
  return {
    command: 'claude',
    args: [
      ...(input.latestHarnessSessionId ? ['--resume', input.latestHarnessSessionId] : []),
      ...(input.model ? ['--model', input.model] : []),
      ...(input.effort ? ['--effort', input.effort] : []),
      '--settings',
      dependencies.settingsPath,
    ],
    cwd: input.cwd,
    launchMode: 'user_shell' as const,
    envForProcess: ({ ptyProcessId }: { readonly ptyProcessId: number }) =>
      harnessEnvForProcess({
        agentSessionId: input.agentSessionId,
        incarnation: { kind: 'pty', ptyProcessId },
        artifacts: dependencies.artifacts,
      }),
  };
});

/** The PTY's hook settings and `ISAGI_*` variables, for an SDK worker's query (ADR 0007). */
export const buildClaudeSdkInstrumentation = Effect.fn('harnesses.buildClaudeSdkInstrumentation')(
  function* (
    input: { readonly agentSessionId: number; readonly executionId: string },
    dependencies: {
      readonly settingsPath: string;
      readonly artifacts: AgentSessionArtifacts['Service'];
    },
  ) {
    const environment = yield* harnessEnvForProcess({
      agentSessionId: input.agentSessionId,
      incarnation: { kind: 'sdk', executionId: input.executionId },
      artifacts: dependencies.artifacts,
    });
    return {
      harness: 'claude',
      environment,
      settingsPath: dependencies.settingsPath,
    } satisfies SdkInstrumentation;
  },
);

export const buildClaudeHeadlessLaunch = Effect.fn('harnesses.buildClaudeHeadlessLaunch')(
  function* (input: HarnessHeadlessLaunchContext) {
    yield* Effect.logInfo('Claude headless launch envelope prepared').pipe(
      Effect.annotateLogs({
        cwd: input.cwd,
        model: input.model,
        effort: input.effort,
      }),
    );
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
  },
);
