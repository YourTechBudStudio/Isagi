import { Effect } from 'effect';

import type { AgentHarness } from '@isagi/contracts';

import type { HarnessEventTokenRegistryService } from '../harness-events/token-registry.js';
import { launchEnv } from '../pty-processes/service/runtime-namespace.js';

export function harnessEnvForProcess(input: {
  readonly agentSessionId: number;
  readonly ptyProcessId: number;
  readonly harness: AgentHarness;
  readonly eventUrl: string;
  readonly tokens: HarnessEventTokenRegistryService;
  readonly extraEnv?: NodeJS.ProcessEnv | undefined;
}) {
  return input.tokens
    .create({
      agentSessionId: input.agentSessionId,
      ptyProcessId: input.ptyProcessId,
      harness: input.harness,
    })
    .pipe(
      Effect.map((token) => {
        console.info('[runtime] Harness event token created for process launch', {
          agentSessionId: input.agentSessionId,
          ptyProcessId: input.ptyProcessId,
          harness: input.harness,
        });
        const env: NodeJS.ProcessEnv = {
          ...launchEnv(),
          ...input.extraEnv,
          ISAGI_AGENT_SESSION_ID: String(input.agentSessionId),
          ISAGI_HARNESS_EVENT_URL: input.eventUrl,
          ISAGI_HARNESS_EVENT_TOKEN: token.token,
        };
        return env;
      }),
    );
}
