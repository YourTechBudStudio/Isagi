import { Effect } from 'effect';

import { harnessEnvForProcess } from '../env.js';
import type { AgentSessionArtifactsService } from '../ledger.js';
import type { HarnessLaunchContext } from '../types.js';

export function buildCodexLaunch(
  input: HarnessLaunchContext,
  dependencies: {
    readonly hookPath: string;
    readonly artifacts: AgentSessionArtifactsService;
  },
) {
  return Effect.sync(() => {
    console.info('[runtime] Codex harness launch envelope prepared', {
      agentSessionId: input.agentSessionId,
      cwd: input.cwd,
      latestHarnessSessionId: input.latestHarnessSessionId,
      hookPath: dependencies.hookPath,
    });
    return {
      command: 'codex',
      args: [
        ...codexHookArgs(dependencies.hookPath),
        ...(input.latestHarnessSessionId ? ['resume', input.latestHarnessSessionId] : []),
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
