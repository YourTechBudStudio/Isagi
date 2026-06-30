import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import BetterSqlite from 'better-sqlite3';
import { Effect } from 'effect';

import type { HarnessObservationRecord } from '../projection.js';
import type { ConversationMessage } from '../types.js';

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
    const nativeEntries = yield* readCodexEntriesFromPaths({
      agentSessionId: input.agentSessionId,
      paths: yield* nativeCodexTranscriptPaths(input),
      missingIsExpected: true,
    });
    if (nativeEntries.foundReadable) return conversationFromCodexEntries(nativeEntries.entries);

    const transcriptEntries = yield* readCodexEntriesFromPaths({
      agentSessionId: input.agentSessionId,
      paths: stopHookTranscriptPaths(input.streams),
      missingIsExpected: false,
    });
    return conversationFromCodexEntries(transcriptEntries.entries);
  });
}

export function parseCodexTranscript(raw: string): readonly ConversationMessage[] {
  return conversationFromCodexEntries(parseCodexTranscriptEntries(raw));
}

function textPart(text: string): ConversationMessage['parts'] {
  return text ? [{ type: 'text', text }] : [];
}

interface CodexTranscriptPath {
  readonly harnessSessionId: string;
  readonly path: string;
}

function nativeCodexTranscriptPaths(input: {
  readonly agentSessionId: number;
  readonly harnessSessionId?: string | null | undefined;
  readonly codexDirectory?: string | undefined;
}) {
  return Effect.gen(function* () {
    if (!input.harnessSessionId) return [];
    const codexDirectory = input.codexDirectory ?? join(homedir(), '.codex');
    const indexedPath = yield* indexedCodexTranscriptPath({
      agentSessionId: input.agentSessionId,
      harnessSessionId: input.harnessSessionId,
      codexDirectory,
    });
    const paths: CodexTranscriptPath[] = indexedPath
      ? [{ harnessSessionId: input.harnessSessionId, path: indexedPath }]
      : [];
    paths.push(
      ...(yield* discoverNativeTranscriptPaths({
        agentSessionId: input.agentSessionId,
        harnessSessionId: input.harnessSessionId,
        codexDirectory,
      })),
    );
    return paths;
  });
}

function indexedCodexTranscriptPath(input: {
  readonly agentSessionId: number;
  readonly harnessSessionId: string;
  readonly codexDirectory: string;
}) {
  return Effect.try({
    try: () => {
      const database = new BetterSqlite(join(input.codexDirectory, 'state_5.sqlite'), {
        readonly: true,
        fileMustExist: true,
      });
      try {
        const row = database
          .prepare('select rollout_path from threads where id = ? limit 1')
          .get(input.harnessSessionId) as { readonly rollout_path?: unknown } | undefined;
        return typeof row?.rollout_path === 'string' && row.rollout_path ? row.rollout_path : null;
      } finally {
        database.close();
      }
    },
    catch: (error) => error,
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        if (!isMissingCodexIndexError(error)) {
          console.warn('[runtime] Codex thread index could not be read', {
            agentSessionId: input.agentSessionId,
            harnessSessionId: input.harnessSessionId,
            codexDirectory: input.codexDirectory,
            error,
          });
        }
        return null;
      }),
    ),
  );
}

function discoverNativeTranscriptPaths(input: {
  readonly agentSessionId: number;
  readonly harnessSessionId: string;
  readonly codexDirectory: string;
}) {
  return Effect.gen(function* () {
    const sessionsDirectory = join(input.codexDirectory, 'sessions');
    const candidates = yield* findTranscriptFiles({
      directory: sessionsDirectory,
      harnessSessionId: input.harnessSessionId,
      depthRemaining: 4,
    });
    const paths: CodexTranscriptPath[] = [];
    for (const path of candidates) {
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

function findTranscriptFiles(input: {
  readonly directory: string;
  readonly harnessSessionId: string;
  readonly depthRemaining: number;
}): Effect.Effect<readonly string[]> {
  return Effect.gen(function* () {
    const entries = yield* Effect.tryPromise({
      try: () => readdir(input.directory, { withFileTypes: true }),
      catch: (error) => error,
    }).pipe(Effect.catchAll(() => Effect.succeed([])));

    const paths: string[] = [];
    for (const entry of entries) {
      const path = join(input.directory, entry.name);
      if (entry.isFile() && isCodexTranscriptFile(entry.name, input.harnessSessionId)) {
        paths.push(path);
        continue;
      }
      if (entry.isDirectory() && input.depthRemaining > 0) {
        paths.push(
          ...(yield* findTranscriptFiles({
            directory: path,
            harnessSessionId: input.harnessSessionId,
            depthRemaining: input.depthRemaining - 1,
          })),
        );
      }
    }
    return paths;
  });
}

function isCodexTranscriptFile(name: string, harnessSessionId: string) {
  return name.endsWith(`${harnessSessionId}.jsonl`) && name.startsWith('rollout-');
}

function stopHookTranscriptPaths(
  streams: readonly [harnessSessionId: string, records: readonly HarnessObservationRecord[]][],
) {
  const paths: CodexTranscriptPath[] = [];
  const seen = new Set<string>();
  for (const [harnessSessionId, records] of streams) {
    for (const record of records) {
      if (record.harness !== 'codex') continue;
      const transcriptPath = stringField(eventObject(record.event).input, 'transcript_path');
      if (!transcriptPath || seen.has(transcriptPath)) continue;
      seen.add(transcriptPath);
      paths.push({ harnessSessionId, path: transcriptPath });
    }
  }
  return paths;
}

function readCodexEntriesFromPaths(input: {
  readonly agentSessionId: number;
  readonly paths: readonly CodexTranscriptPath[];
  readonly missingIsExpected: boolean;
}) {
  return Effect.gen(function* () {
    const entries: CodexTranscriptEntry[] = [];
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
      entries.push(...parseCodexTranscriptEntries(raw));
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
        console.warn('[runtime] Codex transcript could not be read', {
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

type CodexTranscriptEntry = Record<string, unknown>;

function parseCodexTranscriptEntries(raw: string): readonly CodexTranscriptEntry[] {
  const entries: CodexTranscriptEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === 'object') entries.push(parsed as CodexTranscriptEntry);
    } catch {
      // Transcript parsing is best effort; skip malformed native entries.
    }
  }
  return entries;
}

function conversationFromCodexEntries(
  entries: readonly CodexTranscriptEntry[],
): readonly ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== 'event_msg') continue;
    const payload = eventObject(entry.payload);
    if (payload.type === 'user_message') {
      const parts = textPart(stringValue(payload.message));
      if (parts.length > 0) messages.push({ role: 'user', parts });
      continue;
    }
    if (payload.type === 'task_complete') {
      const parts = textPart(stringValue(payload.last_agent_message));
      if (parts.length > 0) messages.push({ role: 'assistant', parts });
      continue;
    }
    if (payload.type === 'thread_rolled_back') {
      rollbackCodexTurns(messages, numberValue(payload.num_turns));
    }
  }
  return messages;
}

function rollbackCodexTurns(messages: ConversationMessage[], count: number) {
  for (let remaining = count; remaining > 0 && messages.length > 0; remaining -= 1) {
    const userIndex = lastUserMessageIndex(messages);
    if (userIndex >= 0) {
      messages.splice(userIndex);
      continue;
    }
    messages.pop();
  }
}

function lastUserMessageIndex(messages: readonly ConversationMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return index;
  }
  return -1;
}

function transcriptContainsSessionId(raw: string, harnessSessionId: string) {
  return parseCodexTranscriptEntries(raw).some((entry) => {
    if (entry.type !== 'session_meta') return false;
    const payload = eventObject(entry.payload);
    return payload.session_id === harnessSessionId || payload.id === harnessSessionId;
  });
}

function stringField(value: unknown, key: string) {
  const object = eventObject(value);
  const field = object[key];
  return typeof field === 'string' && field ? field : null;
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
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

function isMissingCodexIndexError(error: unknown) {
  if (isMissingFileError(error)) return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'SQLITE_CANTOPEN'
  );
}
