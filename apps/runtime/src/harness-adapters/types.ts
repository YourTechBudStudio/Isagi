import type { Effect } from 'effect';

import type { AgentHarness } from '@isagi/contracts';

import type { LaunchPtyProcessInput } from '../pty-processes/types.js';

export interface HarnessLaunchContext {
  readonly agentSessionId: number;
  readonly harness: AgentHarness;
  readonly cwd: string;
  readonly latestHarnessSessionId: string | null;
}

export interface HarnessAdapter {
  readonly harness: AgentHarness;
  readonly buildLaunch: (
    input: HarnessLaunchContext,
  ) => Effect.Effect<LaunchPtyProcessInput, HarnessAdapterError>;
}

export class HarnessAdapterError extends Error {
  readonly _tag = 'HarnessAdapterError';
  constructor(
    readonly code: 'unsupported_harness' | 'artifact_write_failed',
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}
