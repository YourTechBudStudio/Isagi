import { Effect } from 'effect';

import { harnessEnvForProcess } from '../env.js';
import { shellQuote } from '../ledger.common.js';
import type { AgentSessionArtifacts } from '../ledger.js';
import type {
  HarnessHeadlessLaunchContext,
  HarnessLaunchContext,
  SdkInstrumentation,
} from '../types.js';

export const buildCodexLaunch = Effect.fn('harnesses.buildCodexLaunch')(function* (
  input: HarnessLaunchContext,
  dependencies: {
    readonly hookPath: string;
    readonly artifacts: AgentSessionArtifacts['Service'];
  },
) {
  yield* Effect.logInfo('Codex harness launch envelope prepared').pipe(
    Effect.annotateLogs({
      agentSessionId: input.agentSessionId,
      cwd: input.cwd,
      latestHarnessSessionId: input.latestHarnessSessionId,
      model: input.model,
      effort: input.effort,
      hookPath: dependencies.hookPath,
    }),
  );
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
        incarnation: { kind: 'pty', ptyProcessId },
        artifacts: dependencies.artifacts,
      }),
  };
});

/**
 * The same per-invocation hook as the PTY, shaped for the Codex app server: the trust flag before
 * the subcommand, the hook override after it, and the per-thread trust bypass that hooks also need
 * there (ADR 0007).
 */
export const buildCodexSdkInstrumentation = Effect.fn('harnesses.buildCodexSdkInstrumentation')(
  function* (
    input: { readonly agentSessionId: number; readonly executionId: string },
    dependencies: {
      readonly hookPath: string;
      readonly artifacts: AgentSessionArtifacts['Service'];
    },
  ) {
    const environment = yield* harnessEnvForProcess({
      agentSessionId: input.agentSessionId,
      incarnation: { kind: 'sdk', executionId: input.executionId },
      artifacts: dependencies.artifacts,
    });
    return {
      harness: 'codex',
      environment,
      args: {
        beforeSubcommand: [codexHookTrustFlag],
        appServer: ['--enable', 'hooks', '-c', codexSessionStartOverride(dependencies.hookPath)],
      },
      thread: { config: { bypass_hook_trust: true }, sessionStartSource: 'startup' },
    } satisfies SdkInstrumentation;
  },
);

export const buildCodexHeadlessLaunch = Effect.fn('harnesses.buildCodexHeadlessLaunch')(function* (
  input: HarnessHeadlessLaunchContext,
) {
  yield* Effect.logInfo('Codex headless launch envelope prepared').pipe(
    Effect.annotateLogs({
      cwd: input.cwd,
      model: input.model,
      effort: input.effort,
    }),
  );
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

function codexHookArgs(hookPath: string) {
  return ['--enable', 'hooks', codexHookTrustFlag, '-c', codexSessionStartOverride(hookPath)];
}

/**
 * Isagi generates this command hook at runtime startup and injects only a process-scoped event
 * token, so no persisted Codex hook trust is mutated. The app server accepts it only before its
 * subcommand.
 */
export const codexHookTrustFlag = '--dangerously-bypass-hook-trust';

/** The `-c` value that registers Isagi's `SessionStart` hook for one invocation. */
export function codexSessionStartOverride(hookPath: string) {
  const command = `node ${shellQuote(hookPath)}`;
  const hook = `{ type = "command", command = ${tomlString(command)}, timeout = 5, statusMessage = "Recording Codex session" }`;
  const sessionStartHook = `{ matcher = "startup|resume|clear", hooks = [${hook}] }`;
  return `hooks.SessionStart=[${sessionStartHook}]`;
}

function tomlString(value: string) {
  return JSON.stringify(value);
}
