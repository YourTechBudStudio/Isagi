import { Effect } from 'effect';

import type { HarnessObservationRecord } from '../projection.js';
import type { ConversationMessage } from '../types.js';
import {
  hookCodexRolloutPaths,
  locateCodexRolloutPaths,
  parseCodexRolloutEntries,
  readCodexRolloutEntries,
  type CodexRolloutEntry,
} from './native-artifacts.js';

export function readCodexConversation(input: {
  readonly agentSessionId: number;
  readonly cwd?: string | null | undefined;
  readonly harnessSessionId?: string | null | undefined;
  readonly codexDirectory?: string | undefined;
  readonly streams: readonly [
    harnessSessionId: string,
    records: readonly HarnessObservationRecord[],
  ][];
}): Effect.Effect<readonly ConversationMessage[]> {
  return Effect.gen(function* () {
    const nativeEntries = yield* readCodexRolloutEntries({
      agentSessionId: input.agentSessionId,
      paths: yield* locateCodexRolloutPaths(input),
      missingIsExpected: true,
    });
    if (nativeEntries.foundReadable) return conversationFromCodexEntries(nativeEntries.entries);
    const hookEntries = yield* readCodexRolloutEntries({
      agentSessionId: input.agentSessionId,
      paths: hookCodexRolloutPaths(input.streams),
      missingIsExpected: false,
    });
    return conversationFromCodexEntries(hookEntries.entries);
  });
}

export function parseCodexTranscript(raw: string): readonly ConversationMessage[] {
  return conversationFromCodexEntries(parseCodexRolloutEntries(raw));
}

function conversationFromCodexEntries(
  entries: readonly CodexRolloutEntry[],
): readonly ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== 'event_msg') continue;
    const payload = object(entry.payload);
    if (payload.type === 'user_message') {
      const text = stringValue(payload.message);
      if (text) messages.push({ role: 'user', parts: [{ type: 'text', text }] });
    } else if (payload.type === 'task_complete') {
      const text = stringValue(payload.last_agent_message);
      if (text) messages.push({ role: 'assistant', parts: [{ type: 'text', text }] });
    } else if (payload.type === 'thread_rolled_back') {
      rollbackCodexTurns(messages, numberValue(payload.num_turns));
    }
  }
  return messages;
}

function rollbackCodexTurns(messages: ConversationMessage[], count: number) {
  for (let remaining = count; remaining > 0 && messages.length > 0; remaining -= 1) {
    const userIndex = [...messages].map((message) => message.role).lastIndexOf('user');
    if (userIndex >= 0) messages.splice(userIndex);
    else messages.pop();
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
