import type { HarnessObservationRecord } from '../projection.js';
import type { ConversationMessage } from '../types.js';

export function deriveCodexConversation(
  records: readonly HarnessObservationRecord[],
): readonly ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  let terminalSeenForCurrentTurn = true;
  for (const record of records) {
    if (record.harness !== 'codex') continue;
    if (record.nativeEvent === 'UserPromptSubmit') {
      terminalSeenForCurrentTurn = false;
      const parts = textPart(inputString(record, 'prompt'));
      if (parts.length > 0) messages.push({ role: 'user', parts });
      continue;
    }
    if (!terminalSeenForCurrentTurn && record.nativeEvent === 'Stop') {
      terminalSeenForCurrentTurn = true;
      const parts = textPart(inputString(record, 'last_assistant_message'));
      if (parts.length > 0) messages.push({ role: 'assistant', parts });
    }
  }
  return messages;
}

function inputString(record: HarnessObservationRecord, key: string) {
  const event = eventObject(record.event);
  const input = eventObject(event.input);
  const value = input[key];
  return typeof value === 'string' ? value : '';
}

function textPart(text: string): ConversationMessage['parts'] {
  return text ? [{ type: 'text', text }] : [];
}

function eventObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
