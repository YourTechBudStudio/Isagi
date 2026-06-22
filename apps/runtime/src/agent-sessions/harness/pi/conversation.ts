import type { HarnessObservationRecord } from '../projection.js';
import type { ConversationMessage } from '../types.js';

export function derivePiConversation(
  records: readonly HarnessObservationRecord[],
): readonly ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  let assistantParts: ConversationMessage['parts'] = [];

  const flushAssistant = () => {
    if (assistantParts.length === 0) return;
    messages.push({ role: 'assistant', parts: assistantParts });
    assistantParts = [];
  };

  for (const record of records) {
    if (record.harness !== 'pi') continue;
    if (record.nativeEvent === 'agent_start') {
      flushAssistant();
      continue;
    }
    if (record.nativeEvent === 'agent_end') {
      flushAssistant();
      continue;
    }
    if (record.nativeEvent !== 'message_end') continue;
    const message = piMessage(record);
    if (!message) continue;
    if (message.role === 'user') {
      flushAssistant();
      const parts = textPartsFromUserContent(message.content);
      if (parts.length > 0) messages.push({ role: 'user', parts });
      continue;
    }
    if (message.role === 'assistant') {
      assistantParts = [...assistantParts, ...textPartsFromAssistantContent(message.content)];
    }
  }

  flushAssistant();
  return messages;
}

function piMessage(record: HarnessObservationRecord) {
  const event = eventObject(record.event);
  const message = eventObject(eventObject(event.event)?.message);
  const role = message.role;
  if (role !== 'user' && role !== 'assistant') return null;
  return { role, content: message.content };
}

function textPartsFromUserContent(content: unknown): ConversationMessage['parts'] {
  if (typeof content === 'string') return textPart(content);
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    const object = eventObject(part);
    return object.type === 'text' && typeof object.text === 'string' ? textPart(object.text) : [];
  });
}

function textPartsFromAssistantContent(content: unknown): ConversationMessage['parts'] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    const object = eventObject(part);
    if (object.type === 'text' && typeof object.text === 'string') return textPart(object.text);
    // v1: intentionally skipping tool-call parts
    return [];
  });
}

function textPart(text: string): ConversationMessage['parts'] {
  return text ? [{ type: 'text', text }] : [];
}

function eventObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
