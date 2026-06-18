import { Effect } from 'effect';

import type { AgentSessionArtifactsService } from '../agent-sessions/index.js';
import { launchEnv } from '../pty-processes/service/runtime-namespace.js';

export function harnessEnvForProcess(input: {
  readonly agentSessionId: number;
  readonly ptyProcessId: number;
  readonly artifacts: AgentSessionArtifactsService;
  readonly extraEnv?: NodeJS.ProcessEnv | undefined;
}) {
  return Effect.sync(() => {
    const paths = input.artifacts.paths({
      agentSessionId: input.agentSessionId,
      ptyProcessId: input.ptyProcessId,
    });
    return {
      ...launchEnv(),
      ...input.extraEnv,
      ISAGI_AGENT_SESSION_ID: String(input.agentSessionId),
      ISAGI_PTY_PROCESS_ID: String(input.ptyProcessId),
      ISAGI_HARNESS_METADATA_PATH: paths.metadataPath,
      ...(paths.jsonlPath ? { ISAGI_HARNESS_JSONL_PATH: paths.jsonlPath } : {}),
    } satisfies NodeJS.ProcessEnv;
  });
}
