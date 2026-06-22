import { readFile } from 'node:fs/promises';

import { Effect } from 'effect';

import type { HarnessObservationRecord } from '../projection.js';
import type { ConversationMessage } from '../types.js';

export function readClaudeConversation(input: {
  readonly agentSessionId: number;
  readonly streams: readonly [
    harnessSessionId: string,
    records: readonly HarnessObservationRecord[],
  ][];
}): Effect.Effect<readonly ConversationMessage[]> {
  return Effect.gen(function* () {
    const entries: ClaudeTranscriptEntry[] = [];
    const seenUuids = new Set<string>();
    for (const [harnessSessionId, records] of input.streams) {
      for (const transcriptPath of transcriptPaths(records)) {
        const raw = yield* readTranscriptFile({
          agentSessionId: input.agentSessionId,
          harnessSessionId,
          transcriptPath,
        });
        for (const entry of parseClaudeTranscriptEntries(raw)) {
          const uuid = stableUuid(entry);
          if (uuid) {
            if (seenUuids.has(uuid)) continue;
            seenUuids.add(uuid);
          }
          entries.push(entry);
        }
      }
    }
    return conversationFromClaudeEntries(entries);
  });
}

export function parseClaudeTranscript(raw: string): readonly ConversationMessage[] {
  return conversationFromClaudeEntries(parseClaudeTranscriptEntries(raw));
}

function readTranscriptFile(input: {
  readonly agentSessionId: number;
  readonly harnessSessionId: string;
  readonly transcriptPath: string;
}) {
  return Effect.tryPromise({
    try: () => readFile(input.transcriptPath, 'utf8'),
    catch: (error) => error,
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        console.warn('[runtime] Claude transcript could not be read', {
          agentSessionId: input.agentSessionId,
          harnessSessionId: input.harnessSessionId,
          transcriptPath: input.transcriptPath,
          error,
        });
        return '';
      }),
    ),
  );
}

function transcriptPaths(records: readonly HarnessObservationRecord[]) {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (record.harness !== 'claude' || record.nativeEvent !== 'Stop') continue;
    const transcriptPath = stringField(eventObject(record.event).input, 'transcript_path');
    if (!transcriptPath || seen.has(transcriptPath)) continue;
    seen.add(transcriptPath);
    paths.push(transcriptPath);
  }
  return paths;
}

type ClaudeTranscriptEntry = Record<string, unknown>;

function parseClaudeTranscriptEntries(raw: string): readonly ClaudeTranscriptEntry[] {
  const entries: ClaudeTranscriptEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === 'object') entries.push(parsed as ClaudeTranscriptEntry);
    } catch {
      // Transcript parsing is best effort; skip malformed native entries.
    }
  }
  return entries;
}

function conversationFromClaudeEntries(
  entries: readonly ClaudeTranscriptEntry[],
): readonly ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  let assistantParts: ConversationMessage['parts'] = [];

  const flushAssistant = () => {
    if (assistantParts.length === 0) return;
    messages.push({ role: 'assistant', parts: assistantParts });
    assistantParts = [];
  };

  for (const entry of entries) {
    if (isTypedUserEntry(entry)) {
      flushAssistant();
      const parts = textPart(userPromptText(entry));
      if (parts.length > 0) messages.push({ role: 'user', parts });
      continue;
    }
    if (isAssistantEntry(entry)) {
      assistantParts = [...assistantParts, ...assistantTextParts(entry)];
    }
  }

  flushAssistant();
  return messages;
}

function isTypedUserEntry(entry: ClaudeTranscriptEntry) {
  return entry.type === 'user' && entry.promptSource === 'typed';
}

function isAssistantEntry(entry: ClaudeTranscriptEntry) {
  return entry.type === 'assistant';
}

function userPromptText(entry: ClaudeTranscriptEntry) {
  const message = eventObject(entry.message);
  const content = message.content ?? entry.content;
  return typeof content === 'string' ? content : '';
}

function assistantTextParts(entry: ClaudeTranscriptEntry): ConversationMessage['parts'] {
  const message = eventObject(entry.message);
  const content = message.content ?? entry.content;
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

function stableUuid(entry: ClaudeTranscriptEntry) {
  return typeof entry.uuid === 'string' && entry.uuid ? entry.uuid : null;
}

function stringField(value: unknown, key: string) {
  const object = eventObject(value);
  const field = object[key];
  return typeof field === 'string' && field ? field : null;
}

function eventObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
