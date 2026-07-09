import { Effect } from 'effect';

import { harnessEnvForProcess } from '../env.js';
import type { AgentSessionArtifactsService } from '../ledger.js';
import type { HarnessHeadlessLaunchContext, HarnessLaunchContext } from '../types.js';

export function buildCodexLaunch(
  input: HarnessLaunchContext,
  dependencies: {
    readonly hookPath: string;
    readonly artifacts: AgentSessionArtifactsService;
    readonly runtimeUrl: string;
  },
) {
  return Effect.sync(() => {
    console.info('[runtime] Codex harness launch envelope prepared', {
      agentSessionId: input.agentSessionId,
      cwd: input.cwd,
      latestHarnessSessionId: input.latestHarnessSessionId,
      model: input.model,
      effort: input.effort,
      hookPath: dependencies.hookPath,
    });
    return {
      command: 'codex',
      args: [
        ...codexHookArgs(dependencies.hookPath),
        ...(input.model ? ['--model', input.model] : []),
        ...(input.effort ? ['-c', `model_reasoning_effort=${JSON.stringify(input.effort)}`] : []),
        ...(input.latestHarnessSessionId ? ['resume', input.latestHarnessSessionId] : []),
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

export function buildCodexHeadlessLaunch(input: HarnessHeadlessLaunchContext) {
  return Effect.sync(() => {
    console.info('[runtime] Codex headless launch envelope prepared', {
      cwd: input.cwd,
      model: input.model,
      effort: input.effort,
    });
    return {
      command: 'codex',
      args: [
        'exec',
        '--json',
        '-C',
        input.cwd,
        ...(input.model ? ['--model', input.model] : []),
        ...(input.effort ? ['-c', `model_reasoning_effort=${JSON.stringify(input.effort)}`] : []),
        input.prompt,
      ],
      cwd: input.cwd,
      launchMode: 'user_shell' as const,
    };
  });
}

function codexHookArgs(hookPath: string) {
  const command = `node ${shellQuote(hookPath)}`;
  const hook = `{ type = "command", command = ${tomlString(command)}, timeout = 5, statusMessage = "Recording Codex session" }`;
  const inputHook = `{ hooks = [${hook}] }`;
  const sessionStartHook = `{ matcher = "startup|resume", hooks = [${hook}] }`;
  return [
    '--enable',
    'hooks',
    // Isagi generates this command hook at runtime startup and injects only a
    // process-scoped event token, so no persisted Codex hook trust is mutated.
    '--dangerously-bypass-hook-trust',
    '-c',
    `hooks.SessionStart=[${sessionStartHook}]`,
    '-c',
    `hooks.UserPromptSubmit=[${inputHook}]`,
    '-c',
    `hooks.Stop=[${inputHook}]`,
  ];
}

function tomlString(value: string) {
  return JSON.stringify(value);
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
