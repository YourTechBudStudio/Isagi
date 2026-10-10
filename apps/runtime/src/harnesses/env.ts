import { Effect } from 'effect';

import type { AgentSessionArtifacts } from './ledger.js';

export function harnessEnvForProcess(input: {
  readonly agentSessionId: number;
  readonly ptyProcessId: number;
  readonly artifacts: AgentSessionArtifacts['Service'];
  readonly extraEnv?: NodeJS.ProcessEnv | undefined;
}) {
  return Effect.gen(function* () {
    const paths = yield* input.artifacts
      .prepareProcessArtifacts({
        agentSessionId: input.agentSessionId,
        ptyProcessId: input.ptyProcessId,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            console.warn('[runtime] Agent session process artifact preparation failed', {
              agentSessionId: input.agentSessionId,
              ptyProcessId: input.ptyProcessId,
              path: error.path,
              code: error.code,
              cause: error.cause,
            });
            return input.artifacts.paths({
              agentSessionId: input.agentSessionId,
              ptyProcessId: input.ptyProcessId,
            });
          }),
        ),
      );
    const environment: NodeJS.ProcessEnv = {
      ...input.extraEnv,
      ISAGI_AGENT_SESSION_ID: String(input.agentSessionId),
      ISAGI_PTY_PROCESS_ID: String(input.ptyProcessId),
      ISAGI_HARNESS_ARTIFACT_DIRECTORY: paths.directory,
      ISAGI_HARNESS_METADATA_PATH: paths.metadataPath,
    };
    return environment;
  });
}
