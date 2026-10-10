import { Effect } from 'effect';

import { describeOperationalCause } from '../platform/diagnostics/index.js';
import type { AgentSessionArtifacts } from './ledger.js';

export const harnessEnvForProcess = Effect.fn('harnesses.harnessEnvForProcess')(function* (input: {
  readonly agentSessionId: number;
  readonly ptyProcessId: number;
  readonly artifacts: AgentSessionArtifacts['Service'];
  readonly extraEnv?: NodeJS.ProcessEnv | undefined;
}) {
  const paths = yield* input.artifacts
    .prepareProcessArtifacts({
      agentSessionId: input.agentSessionId,
      ptyProcessId: input.ptyProcessId,
    })
    .pipe(
      Effect.catch((error) =>
        Effect.logWarning('Agent session process artifact preparation failed').pipe(
          Effect.annotateLogs({
            agentSessionId: input.agentSessionId,
            ptyProcessId: input.ptyProcessId,
            path: error.path,
            code: error.code,
            cause: describeOperationalCause(error.cause),
          }),
          Effect.as(
            input.artifacts.paths({
              agentSessionId: input.agentSessionId,
              ptyProcessId: input.ptyProcessId,
            }),
          ),
        ),
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
