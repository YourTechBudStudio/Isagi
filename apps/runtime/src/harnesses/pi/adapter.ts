import { Effect } from 'effect';

import { harnessEnvForProcess } from '../env.js';
import type { AgentSessionArtifacts } from '../ledger.js';
import type { HarnessHeadlessLaunchContext, HarnessLaunchContext } from '../types.js';

export const buildPiLaunch = Effect.fn('harnesses.buildPiLaunch')(function* (
  input: HarnessLaunchContext,
  dependencies: {
    readonly extensionPath: string;
    readonly artifacts: AgentSessionArtifacts['Service'];
  },
) {
  yield* Effect.logInfo('Pi harness launch envelope prepared').pipe(
    Effect.annotateLogs({
      agentSessionId: input.agentSessionId,
      cwd: input.cwd,
      latestHarnessSessionId: input.latestHarnessSessionId,
      model: input.model,
      effort: input.effort,
      extensionPath: dependencies.extensionPath,
    }),
  );
  return {
    command: 'pi',
    args: [
      ...(input.latestHarnessSessionId ? ['--session', input.latestHarnessSessionId] : []),
      ...(input.model ? ['--model', input.model] : []),
      ...(input.effort ? ['--thinking', input.effort] : []),
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
      }),
  };
});

export const buildPiHeadlessLaunch = Effect.fn('harnesses.buildPiHeadlessLaunch')(function* (
  input: HarnessHeadlessLaunchContext,
) {
  yield* Effect.logInfo('Pi headless launch envelope prepared').pipe(
    Effect.annotateLogs({
      cwd: input.cwd,
      model: input.model,
      effort: input.effort,
    }),
  );
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
