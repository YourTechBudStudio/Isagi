import { Effect } from 'effect';

import { describeOperationalCause } from '../platform/diagnostics/index.js';
import type { ProcessIncarnation } from './incarnation.js';
import type { AgentSessionArtifacts } from './ledger.js';

export const harnessEnvForProcess = Effect.fn('harnesses.harnessEnvForProcess')(function* (input: {
  readonly agentSessionId: number;
  readonly incarnation: ProcessIncarnation;
  readonly artifacts: AgentSessionArtifacts['Service'];
  readonly extraEnv?: NodeJS.ProcessEnv | undefined;
}) {
  const paths = yield* input.artifacts
    .prepareProcessArtifacts({ agentSessionId: input.agentSessionId })
    .pipe(
      Effect.catch((error) =>
        Effect.logWarning('Agent session process artifact preparation failed').pipe(
          Effect.annotateLogs({
            agentSessionId: input.agentSessionId,
            incarnation: input.incarnation,
            path: error.path,
            code: error.code,
            cause: describeOperationalCause(error.cause),
          }),
          Effect.as(input.artifacts.paths({ agentSessionId: input.agentSessionId })),
        ),
      ),
    );
  // The hook writer marks each ledger record with exactly one of the two execution IDs.
  const environment: NodeJS.ProcessEnv = {
    ...input.extraEnv,
    ISAGI_AGENT_SESSION_ID: String(input.agentSessionId),
    ...(input.incarnation.kind === 'pty'
      ? { ISAGI_PTY_PROCESS_ID: String(input.incarnation.ptyProcessId) }
      : { ISAGI_SDK_EXECUTION_ID: input.incarnation.executionId }),
    ISAGI_HARNESS_ARTIFACT_DIRECTORY: paths.directory,
    ISAGI_HARNESS_METADATA_PATH: paths.metadataPath,
  };
  return environment;
});
