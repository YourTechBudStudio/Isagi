import { stripAnsi } from '../../lib/ansi.js';

export function extractClaudeHeadlessOutput(raw: string) {
  const clean = stripAnsi(raw).trim();
  const parsed = parseJson(clean) ?? parseFirstJsonValue(clean);
  if (Array.isArray(parsed)) {
    for (let index = parsed.length - 1; index >= 0; index -= 1) {
      const result = stringAt(parsed[index], ['result']);
      if (result) return result.trim();
    }
  }
  const result = stringAt(parsed, ['result']);
  return result ? result.trim() : clean;
}

export function extractCodexHeadlessOutput(raw: string) {
  const clean = stripAnsi(raw);
  const records = parseJsonLines(clean);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const text =
      stringAt(record, ['last_assistant_message']) ??
      stringAt(record, ['lastAssistantMessage']) ??
      stringAt(record, ['item', 'text']) ??
      stringAt(record, ['item', 'content', 0, 'text']) ??
      stringAt(record, ['message', 'content', 0, 'text']) ??
      stringAt(record, ['output_text']) ??
      stringAt(record, ['text']);
    if (text) return text.trim();
  }
  return clean.trim();
}

export function extractPiHeadlessOutput(raw: string) {
  const clean = stripAnsi(raw);
  const records = parseJsonLines(clean);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const messages = arrayAt(record, ['messages']) ?? arrayAt(record, ['event', 'messages']);
    const fromMessages = textFromLastAssistantMessage(messages);
    if (fromMessages) return fromMessages.trim();
    const fromMessage = textFromMessage(
      objectAt(record, ['message']) ?? objectAt(record, ['event', 'message']),
    );
    if (fromMessage) return fromMessage.trim();
  }
  return clean.trim();
}

export function piHeadlessSemanticError(raw: string): string | null {
  const records = parseJsonLines(stripAnsi(raw));
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const stopReason =
      stringAt(records[index], ['event', 'message', 'stopReason']) ??
      stringAt(records[index], ['message', 'stopReason']) ??
      stringAt(records[index], ['stopReason']);
    if (stopReason === 'error' || stopReason === 'aborted') return stopReason;
  }
  return null;
}

export function extractOpenCodeHeadlessOutput(raw: string) {
  const clean = stripAnsi(raw);
  const records = parseJsonLines(clean);
  const textByMessage = new Map<string, string[]>();
  const completedMessageIds: string[] = [];
  for (const record of records) {
    const part =
      objectAt(record, ['event', 'properties', 'part']) ??
      objectAt(record, ['properties', 'part']) ??
      objectAt(record, ['part']);
    const messageId = stringAt(part, ['messageID']) ?? stringAt(part, ['messageId']);
    const text = stringAt(part, ['text']);
    if (messageId && text) {
      const existing = textByMessage.get(messageId) ?? [];
      existing.push(text);
      textByMessage.set(messageId, existing);
    }
    const info =
      objectAt(record, ['event', 'properties', 'info']) ??
      objectAt(record, ['properties', 'info']) ??
      objectAt(record, ['info']);
    const id = stringAt(info, ['id']);
    const role = stringAt(info, ['role']);
    if (id && role === 'assistant') completedMessageIds.push(id);
    const direct = stringAt(record, ['text']) ?? stringAt(record, ['message', 'text']);
    if (direct) {
      textByMessage.set('__direct__', [direct]);
      completedMessageIds.push('__direct__');
    }
  }
  const lastId = completedMessageIds.at(-1);
  return lastId ? (textByMessage.get(lastId) ?? []).join('').trim() : clean.trim();
}

function textFromLastAssistantMessage(messages: readonly unknown[] | null) {
  if (!messages) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = objectAt(messages[index], []);
    if (stringAt(message, ['role']) !== 'assistant') continue;
    const text = textFromMessage(message);
    if (text) return text;
  }
  return null;
}

function textFromMessage(message: Record<string, unknown> | null) {
  if (!message) return null;
  const content = unknownAt(message, ['content']);
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  return content.flatMap((part) => stringAt(part, ['text']) ?? []).join('');
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function parseFirstJsonValue(value: string): unknown {
  const start = value.search(/[[{]/);
  if (start === -1) return null;
  const opening = value[start];
  const closing = opening === '[' ? ']' : '}';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === opening) depth += 1;
    else if (char === closing) depth -= 1;
    if (depth === 0) return parseJson(value.slice(start, index + 1));
  }
  return null;
}

function parseJsonLines(value: string): unknown[] {
  return value.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return [];
    const parsed = parseJson(trimmed);
    return parsed === null ? [] : [parsed];
  });
}

function stringAt(value: unknown, path: readonly (string | number)[]): string | null {
  const found = unknownAt(value, path);
  return typeof found === 'string' ? found : null;
}

function objectAt(value: unknown, path: readonly (string | number)[]) {
  const found = unknownAt(value, path);
  return found && typeof found === 'object' && !Array.isArray(found)
    ? (found as Record<string, unknown>)
    : null;
}

function arrayAt(value: unknown, path: readonly (string | number)[]) {
  const found = unknownAt(value, path);
  return Array.isArray(found) ? found : null;
}

function unknownAt(value: unknown, path: readonly (string | number)[]): unknown {
  let current = value;
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
    } else {
      if (!current || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
}
