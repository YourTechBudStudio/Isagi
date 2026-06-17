import { Effect } from 'effect';

import type { HarnessEventTokenRegistryService } from '../harness-events/token-registry.js';
import { harnessEnvForProcess } from './env.js';
import type { HarnessLaunchContext } from './types.js';

export function buildClaudeLaunch(
  input: HarnessLaunchContext,
  dependencies: {
    readonly settingsPath: string;
    readonly eventUrl: string;
    readonly tokens: HarnessEventTokenRegistryService;
  },
) {
  return Effect.sync(() => {
    console.info('[runtime] Claude harness launch envelope prepared', {
      agentSessionId: input.agentSessionId,
      cwd: input.cwd,
      latestHarnessSessionId: input.latestHarnessSessionId,
      settingsPath: dependencies.settingsPath,
      eventUrl: dependencies.eventUrl,
    });
    return {
      command: 'claude',
      args: [
        ...(input.latestHarnessSessionId ? ['--resume', input.latestHarnessSessionId] : []),
        '--settings',
        dependencies.settingsPath,
      ],
      cwd: input.cwd,
      envForProcess: ({ ptyProcessId }: { readonly ptyProcessId: number }) =>
        harnessEnvForProcess({
          agentSessionId: input.agentSessionId,
          ptyProcessId,
          harness: 'claude',
          eventUrl: dependencies.eventUrl,
          tokens: dependencies.tokens,
        }),
    };
  });
}
