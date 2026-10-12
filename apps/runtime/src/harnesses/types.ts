import { Data, type Effect } from 'effect';

import type { AgentHarness } from '@isagi/contracts';

import type { LaunchPtyProcessInput } from '../pty-processes/index.js';

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

/**
 * A harness launch could not be prepared. `code` is the reason the agent-session and surface API
 * boundaries map to a contract error.
 *
 * The constructor stays positional (`code`, `message`, `cause`) so callers read as they always have.
 */
export class HarnessAdapterError extends Data.TaggedError('HarnessAdapterError')<{
  readonly code: 'unsupported_harness' | 'artifact_write_failed';
  readonly message: string;
  readonly cause?: unknown;
}> {
  constructor(
    code: 'unsupported_harness' | 'artifact_write_failed',
    message: string,
    cause?: unknown,
  ) {
    super({ code, message, cause });
  }
}
