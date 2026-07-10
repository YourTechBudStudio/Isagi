import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { Effect } from 'effect';

import type { HarnessObservationRecord } from '../projection.js';
import type { ConversationMessage } from '../types.js';

export function readClaudeConversation(input: {
  readonly agentSessionId: number;
  readonly cwd?: string | null | undefined;
  readonly harnessSessionId?: string | null | undefined;
  readonly claudeDirectory?: string | undefined;
  readonly streams: readonly [
    harnessSessionId: string,
    records: readonly HarnessObservationRecord[],
  ][];
}): Effect.Effect<readonly ConversationMessage[]> {
  return Effect.gen(function* () {
    const nativePaths = directNativeTranscriptPaths(input);
    const nativeEntries = yield* readClaudeEntriesFromPaths({
      agentSessionId: input.agentSessionId,
      paths: nativePaths,
      missingIsExpected: true,
    });
    const fallbackNativeEntries = nativeEntries.foundReadable
      ? nativeEntries
      : yield* readClaudeEntriesFromPaths({
          agentSessionId: input.agentSessionId,
          paths: yield* discoverNativeTranscriptPaths(input),
          missingIsExpected: true,
        });
    const transcriptRead = fallbackNativeEntries.foundReadable
      ? fallbackNativeEntries
      : yield* readClaudeEntriesFromPaths({
          agentSessionId: input.agentSessionId,
          paths: stopHookTranscriptPaths(input.streams),
          missingIsExpected: false,
        });
    return conversationFromClaudeEntries(transcriptRead.entries);
  });
}

export function parseClaudeTranscript(raw: string): readonly ConversationMessage[] {
  return conversationFromClaudeEntries(
    activeClaudeTranscriptEntries(parseClaudeTranscriptEntries(raw)),
  );
}

function readClaudeEntriesFromPaths(input: {
  readonly agentSessionId: number;
  readonly paths: readonly ClaudeTranscriptPath[];
  readonly missingIsExpected: boolean;
}) {
  return Effect.gen(function* () {
    const entries: ClaudeTranscriptEntry[] = [];
    const seenUuids = new Set<string>();
    const seenPaths = new Set<string>();
    let foundReadable = false;
    for (const transcript of input.paths) {
      if (seenPaths.has(transcript.path)) continue;
      seenPaths.add(transcript.path);
      const raw = yield* readTranscriptFile({
        agentSessionId: input.agentSessionId,
        harnessSessionId: transcript.harnessSessionId,
        transcriptPath: transcript.path,
        missingIsExpected: input.missingIsExpected,
      });
      if (raw === null) continue;
      foundReadable = true;
      for (const entry of activeClaudeTranscriptEntries(parseClaudeTranscriptEntries(raw))) {
        const uuid = stableUuid(entry);
        if (uuid) {
          if (seenUuids.has(uuid)) continue;
          seenUuids.add(uuid);
        }
        entries.push(entry);
      }
    }
    return { entries, foundReadable };
  });
}

function readTranscriptFile(input: {
  readonly agentSessionId: number;
  readonly harnessSessionId: string;
  readonly transcriptPath: string;
  readonly missingIsExpected: boolean;
}): Effect.Effect<string | null> {
  return Effect.tryPromise({
    try: () => readFile(input.transcriptPath, 'utf8'),
    catch: (error) => error,
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        if (input.missingIsExpected && isMissingFileError(error)) return null;
        console.warn('[runtime] Claude transcript could not be read', {
          agentSessionId: input.agentSessionId,
          harnessSessionId: input.harnessSessionId,
          transcriptPath: input.transcriptPath,
          error,
        });
        return null;
      }),
    ),
  );
}

interface ClaudeTranscriptPath {
  readonly harnessSessionId: string;
  readonly path: string;
}

function directNativeTranscriptPaths(input: {
  readonly cwd?: string | null | undefined;
  readonly harnessSessionId?: string | null | undefined;
  readonly claudeDirectory?: string | undefined;
}): readonly ClaudeTranscriptPath[] {
  if (!input.cwd || !input.harnessSessionId) return [];
  return [
    {
      harnessSessionId: input.harnessSessionId,
      path: nativeClaudeTranscriptPath({
        claudeDirectory: input.claudeDirectory ?? join(homedir(), '.claude'),
        cwd: input.cwd,
        harnessSessionId: input.harnessSessionId,
      }),
    },
  ];
}

function discoverNativeTranscriptPaths(input: {
  readonly agentSessionId: number;
  readonly harnessSessionId?: string | null | undefined;
  readonly claudeDirectory?: string | undefined;
}) {
  return Effect.gen(function* () {
    if (!input.harnessSessionId) return [];
    const claudeDirectory = input.claudeDirectory ?? join(homedir(), '.claude');
    const projectsDirectory = join(claudeDirectory, 'projects');
    const projectDirectories = yield* Effect.tryPromise({
      try: () => readdir(projectsDirectory, { withFileTypes: true }),
      catch: (error) => error,
    }).pipe(Effect.catchAll(() => Effect.succeed([])));

    const candidates: ClaudeTranscriptPath[] = [];
    for (const entry of projectDirectories) {
      if (!entry.isDirectory()) continue;
      const path = join(projectsDirectory, entry.name, `${input.harnessSessionId}.jsonl`);
      const raw = yield* readTranscriptFile({
        agentSessionId: input.agentSessionId,
        harnessSessionId: input.harnessSessionId,
        transcriptPath: path,
        missingIsExpected: true,
      });
      if (raw === null) continue;
      if (!transcriptContainsSessionId(raw, input.harnessSessionId)) continue;
      candidates.push({ harnessSessionId: input.harnessSessionId, path });
    }
    return candidates;
  });
}

export function nativeClaudeTranscriptPath(input: {
  readonly claudeDirectory: string;
  readonly cwd: string;
  readonly harnessSessionId: string;
}) {
  return join(
    input.claudeDirectory,
    'projects',
    claudeProjectDirectoryName(input.cwd),
    `${input.harnessSessionId}.jsonl`,
  );
}

function claudeProjectDirectoryName(cwd: string) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

function stopHookTranscriptPaths(
  streams: readonly [harnessSessionId: string, records: readonly HarnessObservationRecord[]][],
) {
  const paths: ClaudeTranscriptPath[] = [];
  const seen = new Set<string>();
  for (const [harnessSessionId, records] of streams) {
    for (const record of records) {
      if (record.harness !== 'claude' || record.nativeEvent !== 'Stop') continue;
      const event = eventObject(record.event);
      const transcriptPath = stringField(event, 'transcript_path');
      if (!transcriptPath || seen.has(transcriptPath)) continue;
      seen.add(transcriptPath);
      paths.push({ harnessSessionId, path: transcriptPath });
    }
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

function activeClaudeTranscriptEntries(
  entries: readonly ClaudeTranscriptEntry[],
): readonly ClaudeTranscriptEntry[] {
  const leafUuid = activeLeafUuid(entries);
  if (!leafUuid) return entries;

  const byUuid = entriesByUuid(entries);
  const leaf = byUuid.get(leafUuid);
  if (!leaf) return entries;

  const activeEntries: ClaudeTranscriptEntry[] = [];
  const visited = new Set<string>();
  let current: ClaudeTranscriptEntry | undefined = leaf;
  while (current) {
    const uuid = stableUuid(current);
    if (!uuid || visited.has(uuid)) return entries;
    visited.add(uuid);
    activeEntries.unshift(current);
    const parentUuid = stringField(current, 'parentUuid');
    current = parentUuid ? byUuid.get(parentUuid) : undefined;
  }

  return activeEntries;
}

function activeLeafUuid(entries: readonly ClaudeTranscriptEntry[]) {
  const marker = latestLastPromptMarker(entries);
  if (!marker) return null;
  return postMarkerBranchLeafUuid(entries, marker.index) ?? marker.leafUuid;
}

function latestLastPromptMarker(entries: readonly ClaudeTranscriptEntry[]) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== 'last-prompt') continue;
    const leafUuid = stringField(entry, 'leafUuid');
    if (leafUuid) return { index, leafUuid };
  }
  return null;
}

function postMarkerBranchLeafUuid(entries: readonly ClaudeTranscriptEntry[], markerIndex: number) {
  let sawTypedUser = false;
  let latestUuid: string | null = null;
  for (let index = markerIndex + 1; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (isTypedUserEntry(entry)) sawTypedUser = true;
    const uuid = stableUuid(entry);
    if (sawTypedUser && uuid) latestUuid = uuid;
  }
  return latestUuid;
}

function entriesByUuid(entries: readonly ClaudeTranscriptEntry[]) {
  const byUuid = new Map<string, ClaudeTranscriptEntry>();
  for (const entry of entries) {
    const uuid = stableUuid(entry);
    if (uuid) byUuid.set(uuid, entry);
  }
  return byUuid;
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

function transcriptContainsSessionId(raw: string, harnessSessionId: string) {
  return parseClaudeTranscriptEntries(raw).some(
    (entry) => stringField(entry, 'sessionId') === harnessSessionId,
  );
}

function isMissingFileError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  );
}
