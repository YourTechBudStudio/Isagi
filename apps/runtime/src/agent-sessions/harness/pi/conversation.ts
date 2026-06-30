import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { Effect } from 'effect';

import type { HarnessObservationRecord } from '../projection.js';
import type { ConversationMessage } from '../types.js';

export function readPiConversation(input: {
  readonly agentSessionId: number;
  readonly cwd?: string | null | undefined;
  readonly harnessSessionId?: string | null | undefined;
  readonly piDirectory?: string | undefined;
  readonly streams: readonly [
    harnessSessionId: string,
    records: readonly HarnessObservationRecord[],
  ][];
}): Effect.Effect<readonly ConversationMessage[]> {
  return Effect.gen(function* () {
    const nativeEntries = yield* readPiEntriesFromPaths({
      agentSessionId: input.agentSessionId,
      paths: yield* nativePiTranscriptPaths(input),
      missingIsExpected: true,
    });
    if (nativeEntries.foundReadable) return conversationFromPiEntries(nativeEntries.entries);
    return [];
  });
}

export function parsePiTranscript(raw: string): readonly ConversationMessage[] {
  return conversationFromPiEntries(activePiTranscriptEntries(parsePiTranscriptEntries(raw)));
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

interface PiTranscriptPath {
  readonly harnessSessionId: string;
  readonly path: string;
}

function nativePiTranscriptPaths(input: {
  readonly agentSessionId: number;
  readonly cwd?: string | null | undefined;
  readonly harnessSessionId?: string | null | undefined;
  readonly piDirectory?: string | undefined;
}) {
  return Effect.gen(function* () {
    if (!input.harnessSessionId) return [];
    const piDirectory = input.piDirectory ?? join(homedir(), '.pi');
    const paths: PiTranscriptPath[] = [];
    if (input.cwd) {
      paths.push(
        ...(yield* discoverPiTranscriptPathsInDirectory({
          agentSessionId: input.agentSessionId,
          harnessSessionId: input.harnessSessionId,
          directory: join(piDirectory, 'agent', 'sessions', piProjectDirectoryName(input.cwd)),
        })),
      );
    }
    paths.push(
      ...(yield* discoverNativeTranscriptPaths({
        agentSessionId: input.agentSessionId,
        harnessSessionId: input.harnessSessionId,
        piDirectory,
      })),
    );
    return paths;
  });
}

function discoverNativeTranscriptPaths(input: {
  readonly agentSessionId: number;
  readonly harnessSessionId: string;
  readonly piDirectory: string;
}) {
  return Effect.gen(function* () {
    const sessionsDirectory = join(input.piDirectory, 'agent', 'sessions');
    const projectDirectories = yield* Effect.tryPromise({
      try: () => readdir(sessionsDirectory, { withFileTypes: true }),
      catch: (error) => error,
    }).pipe(Effect.catchAll(() => Effect.succeed([])));

    const paths: PiTranscriptPath[] = [];
    for (const entry of projectDirectories) {
      if (!entry.isDirectory()) continue;
      paths.push(
        ...(yield* discoverPiTranscriptPathsInDirectory({
          agentSessionId: input.agentSessionId,
          harnessSessionId: input.harnessSessionId,
          directory: join(sessionsDirectory, entry.name),
        })),
      );
    }
    return paths;
  });
}

function discoverPiTranscriptPathsInDirectory(input: {
  readonly agentSessionId: number;
  readonly harnessSessionId: string;
  readonly directory: string;
}) {
  return Effect.gen(function* () {
    const files = yield* Effect.tryPromise({
      try: () => readdir(input.directory, { withFileTypes: true }),
      catch: (error) => error,
    }).pipe(Effect.catchAll(() => Effect.succeed([])));

    const paths: PiTranscriptPath[] = [];
    for (const file of files) {
      if (!file.isFile() || !isPiTranscriptFile(file.name, input.harnessSessionId)) continue;
      const path = join(input.directory, file.name);
      const raw = yield* readTranscriptFile({
        agentSessionId: input.agentSessionId,
        harnessSessionId: input.harnessSessionId,
        transcriptPath: path,
        missingIsExpected: true,
      });
      if (raw === null) continue;
      if (!transcriptContainsSessionId(raw, input.harnessSessionId)) continue;
      paths.push({ harnessSessionId: input.harnessSessionId, path });
    }
    return paths;
  });
}

function piProjectDirectoryName(cwd: string) {
  return `-${cwd.replace(/\//g, '-')}-`;
}

function isPiTranscriptFile(name: string, harnessSessionId: string) {
  return name.endsWith(`_${harnessSessionId}.jsonl`);
}

function readPiEntriesFromPaths(input: {
  readonly agentSessionId: number;
  readonly paths: readonly PiTranscriptPath[];
  readonly missingIsExpected: boolean;
}) {
  return Effect.gen(function* () {
    const entries: PiTranscriptEntry[] = [];
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
      entries.push(...activePiTranscriptEntries(parsePiTranscriptEntries(raw)));
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
        console.warn('[runtime] Pi transcript could not be read', {
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

type PiTranscriptEntry = Record<string, unknown>;

function parsePiTranscriptEntries(raw: string): readonly PiTranscriptEntry[] {
  const entries: PiTranscriptEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === 'object') entries.push(parsed as PiTranscriptEntry);
    } catch {
      // Transcript parsing is best effort; skip malformed native entries.
    }
  }
  return entries;
}

function activePiTranscriptEntries(
  entries: readonly PiTranscriptEntry[],
): readonly PiTranscriptEntry[] {
  const latestEntryId = latestPiEntryId(entries);
  if (!latestEntryId) return entries;

  const byId = new Map<string, PiTranscriptEntry>();
  for (const entry of entries) {
    const id = stringValue(entry.id);
    if (id) byId.set(id, entry);
  }

  const branch: PiTranscriptEntry[] = [];
  const seen = new Set<string>();
  let currentId: string | null = latestEntryId;
  while (currentId) {
    if (seen.has(currentId)) return entries;
    seen.add(currentId);

    const entry = byId.get(currentId);
    if (!entry) return entries;
    branch.push(entry);
    currentId = stringValue(entry.parentId);
  }

  branch.reverse();
  const header = entries.filter((entry) => !stringValue(entry.id));
  return [...header, ...branch];
}

function latestPiEntryId(entries: readonly PiTranscriptEntry[]) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const id = stringValue(entries[index]?.id);
    if (id) return id;
  }
  return null;
}

function conversationFromPiEntries(
  entries: readonly PiTranscriptEntry[],
): readonly ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  let assistantParts: ConversationMessage['parts'] = [];

  const flushAssistant = () => {
    if (assistantParts.length === 0) return;
    messages.push({ role: 'assistant', parts: assistantParts });
    assistantParts = [];
  };

  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    const message = eventObject(entry.message);
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

function transcriptContainsSessionId(raw: string, harnessSessionId: string) {
  return parsePiTranscriptEntries(raw).some((entry) => {
    if (entry.type !== 'session') return false;
    return entry.id === harnessSessionId;
  });
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value ? value : null;
}

function eventObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function isMissingFileError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  );
}
