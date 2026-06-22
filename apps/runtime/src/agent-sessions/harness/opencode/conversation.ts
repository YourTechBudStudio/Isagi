import type { HarnessObservationRecord } from '../projection.js';
import type { ConversationMessage } from '../types.js';

export function deriveOpenCodeConversation(
  records: readonly HarnessObservationRecord[],
): readonly ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  let assistantParts: ConversationMessage['parts'] = [];
  const textPartsByMessageId = new Map<string, ConversationMessage['parts']>();
  const completedAssistantMessageIds = new Set<string>();
  const consumedTextPartIds = new Set<string>();

  const flushAssistant = () => {
    if (assistantParts.length === 0) return;
    messages.push({ role: 'assistant', parts: assistantParts });
    assistantParts = [];
  };

  const appendCompletedAssistantText = (messageId: string) => {
    const parts = textPartsByMessageId.get(messageId);
    if (!parts || parts.length === 0) return;
    assistantParts = [...assistantParts, ...parts];
    textPartsByMessageId.delete(messageId);
  };

  for (const record of records) {
    if (record.harness !== 'opencode') continue;
    if (record.nativeEvent === 'chat.message') {
      flushAssistant();
      const parts = userTextParts(record);
      if (parts.length > 0) messages.push({ role: 'user', parts });
      continue;
    }
    if (record.nativeEvent === 'message.part.updated') {
      const part = completedTextPart(record);
      if (!part || consumedTextPartIds.has(part.id)) continue;
      consumedTextPartIds.add(part.id);
      const existing = textPartsByMessageId.get(part.messageId) ?? [];
      textPartsByMessageId.set(part.messageId, [...existing, { type: 'text', text: part.text }]);
      if (completedAssistantMessageIds.has(part.messageId))
        appendCompletedAssistantText(part.messageId);
      continue;
    }
    if (record.nativeEvent === 'message.updated') {
      const messageId = completedAssistantMessageId(record);
      if (!messageId) continue;
      completedAssistantMessageIds.add(messageId);
      appendCompletedAssistantText(messageId);
      continue;
    }
    if (record.nativeEvent === 'session.idle' || record.nativeEvent === 'session.error') {
      flushAssistant();
    }
  }

  flushAssistant();
  return messages;
}

function userTextParts(record: HarnessObservationRecord): ConversationMessage['parts'] {
  const event = eventObject(record.event);
  const output = eventObject(event.output);
  const parts = output.parts;
  if (!Array.isArray(parts)) return [];
  return parts.flatMap((part) => {
    const object = eventObject(part);
    return object.type === 'text' && typeof object.text === 'string' ? textPart(object.text) : [];
  });
}

function completedTextPart(record: HarnessObservationRecord) {
  const event = eventObject(record.event);
  const nativeEvent = eventObject(event.event);
  const properties = eventObject(nativeEvent.properties);
  const part = eventObject(properties.part);
  const id = stringField(part, 'id');
  const messageId = stringField(part, 'messageID') ?? stringField(part, 'messageId');
  const text = stringField(part, 'text');
  if (part.type !== 'text' || !id || !messageId || !text) return null;
  return { id, messageId, text };
}

function completedAssistantMessageId(record: HarnessObservationRecord) {
  const event = eventObject(record.event);
  const nativeEvent = eventObject(event.event);
  const properties = eventObject(nativeEvent.properties);
  const info = eventObject(properties.info);
  if (info.role !== 'assistant') return null;
  const time = eventObject(info.time);
  if (typeof time.completed !== 'number') return null;
  return stringField(info, 'id');
}

function textPart(text: string): ConversationMessage['parts'] {
  return text ? [{ type: 'text', text }] : [];
}

function stringField(value: unknown, key: string) {
  const object = eventObject(value);
  const field = object[key];
  return typeof field === 'string' && field ? field : null;
}

function eventObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
