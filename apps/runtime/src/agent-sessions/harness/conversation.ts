import { Effect } from 'effect';

import type { AgentHarness } from '@isagi/contracts';

import { deriveClaudeConversation } from './claude/conversation.js';
import { deriveCodexConversation } from './codex/conversation.js';
import { deriveOpenCodeConversation } from './opencode/conversation.js';
import { derivePiConversation } from './pi/conversation.js';
import type { HarnessObservationRecord } from './projection.js';
import type { ConversationMessage } from './types.js';

export function getConversationHistory(
  _agentSessionId: number,
): Effect.Effect<readonly ConversationMessage[]> {
  return Effect.succeed([]);
}

export function deriveHarnessConversation(
  harness: AgentHarness,
  records: readonly HarnessObservationRecord[],
): readonly ConversationMessage[] {
  if (harness === 'pi') return derivePiConversation(records);
  if (harness === 'opencode') return deriveOpenCodeConversation(records);
  if (harness === 'claude') return deriveClaudeConversation(records);
  if (harness === 'codex') return deriveCodexConversation(records);
  return [];
}
