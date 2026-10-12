import { Effect } from 'effect';

import type { HarnessConversationTurn } from '../definition-types.js';
import type { HarnessObservationRecord } from '../projection.js';
import type { ConversationMessage } from '../types.js';
import {
  hookCodexRolloutPaths,
  locateCodexRolloutPaths,
  parseCodexRolloutEntries,
  readCodexConversationEntries,
  type CodexRolloutEntry,
} from './native-artifacts.js';

export function readCodexConversation(input: {
  readonly turn?: HarnessConversationTurn | undefined;
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
    const nativeEntries = yield* readCodexConversationEntries({
      agentSessionId: input.agentSessionId,
      paths: yield* locateCodexRolloutPaths(input),
      codexDirectory: input.codexDirectory,
      missingIsExpected: true,
    });
    if (nativeEntries.foundReadable)
      return conversationFromCodexEntries(completedTurnEntries(nativeEntries.entries, input.turn));
    const hookEntries = yield* readCodexConversationEntries({
      agentSessionId: input.agentSessionId,
      paths: hookCodexRolloutPaths(input.streams),
      codexDirectory: input.codexDirectory,
      missingIsExpected: false,
    });
    return conversationFromCodexEntries(completedTurnEntries(hookEntries.entries, input.turn));
  });
}

function completedTurnEntries(
  entries: readonly CodexRolloutEntry[],
  turn?: HarnessConversationTurn,
) {
  if (!turn) return entries;
  if (!turn.completedAt) return [];
  const start = entries.findIndex(
    (entry) =>
      entry.type === 'event_msg' &&
      entry.timestamp === turn.startedAt &&
      object(entry.payload).type === 'task_started',
  );
  if (start < 0) return [];
  const turnId = object(entries[start]?.payload).turn_id;
  if (typeof turnId !== 'string') return [];
  const end = entries.findIndex(
    (entry, index) =>
      index > start &&
      entry.type === 'event_msg' &&
      entry.timestamp === turn.completedAt &&
      object(entry.payload).type === 'task_complete' &&
      object(entry.payload).turn_id === turnId,
  );
  return end < 0 ? [] : entries.slice(start, end + 1);
}

export function parseCodexTranscript(raw: string): readonly ConversationMessage[] {
  return conversationFromCodexEntries(parseCodexRolloutEntries(raw));
}

function conversationFromCodexEntries(
  entries: readonly CodexRolloutEntry[],
): readonly ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  let assistantParts: ConversationMessage['parts'] = [];

  const flushAssistant = () => {
    if (assistantParts.length === 0) return;
    messages.push({ role: 'assistant', parts: assistantParts });
    assistantParts = [];
  };

  for (const entry of entries) {
    if (entry.type !== 'event_msg') continue;
    const payload = object(entry.payload);
    if (payload.type === 'thread_rolled_back') {
      flushAssistant();
      rollbackCodexTurns(messages, numberValue(payload.num_turns));
      continue;
    }
    if (payload.type !== 'item_completed') continue;
    const item = object(payload.item);
    if (item.type === 'UserMessage') {
      flushAssistant();
      const parts = textParts(item.content, 'text');
      if (parts.length > 0) messages.push({ role: 'user', parts });
    } else if (item.type === 'AgentMessage') {
      assistantParts = [...assistantParts, ...textParts(item.content, 'Text')];
    }
  }
  flushAssistant();
  return messages;
}

function textParts(content: unknown, type: 'text' | 'Text'): ConversationMessage['parts'] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    const value = object(part);
    const text = stringValue(value.text);
    return value.type === type && text ? [{ type: 'text' as const, text }] : [];
  });
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
