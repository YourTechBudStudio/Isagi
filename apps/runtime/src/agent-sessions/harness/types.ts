import type { Effect } from 'effect';

import type { AgentHarness } from '@isagi/contracts';

import type { LaunchPtyProcessInput } from '../../pty-processes/types.js';

export type ConversationRole = 'system' | 'user' | 'assistant';
export type PartState = 'streaming' | 'done';

export type ConversationPart = {
  readonly type: 'text';
  readonly text: string;
  readonly state?: PartState;
};
// Reserved for later without changing the top-level message shape:
// | { type: 'reasoning'; text: string; state?: PartState }
// | { type: `tool-${string}`; toolCallId: string; state: 'input-available' | 'output-available' | 'output-error'; input?: unknown; output?: unknown; errorText?: string }
// | { type: 'file'; mediaType: string; url: string; filename?: string }
// | { type: 'step-start' }

export interface ConversationMessage {
  readonly role: ConversationRole;
  readonly parts: readonly ConversationPart[];
}

export interface HarnessLaunchOptions {
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
}

export interface HarnessLaunchContext extends HarnessLaunchOptions {
  readonly agentSessionId: number;
  readonly harness: AgentHarness;
  readonly cwd: string;
  readonly latestHarnessSessionId: string | null;
}

export interface HarnessHeadlessLaunchContext extends HarnessLaunchOptions {
  readonly harness: AgentHarness;
  readonly cwd: string;
  readonly prompt: string;
}

export interface HarnessAdapter {
  readonly harness: AgentHarness;
  readonly buildLaunch: (
    input: HarnessLaunchContext,
  ) => Effect.Effect<LaunchPtyProcessInput, HarnessAdapterError>;
  readonly buildHeadlessLaunch: (
    input: HarnessHeadlessLaunchContext,
  ) => Effect.Effect<LaunchPtyProcessInput, HarnessAdapterError>;
}

export class HarnessAdapterError extends Error {
  readonly _tag = 'HarnessAdapterError';
  constructor(
    readonly code: 'unsupported_harness' | 'artifact_write_failed' | 'runtime_url_unavailable',
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}
