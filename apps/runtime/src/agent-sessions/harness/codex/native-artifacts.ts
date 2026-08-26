import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import BetterSqlite from 'better-sqlite3';
import { Effect } from 'effect';

import type { HarnessObservationRecord } from '../projection.js';

export interface CodexRolloutPath {
  readonly harnessSessionId: string;
  readonly path: string;
}

export type CodexRolloutEntry = Record<string, unknown>;

interface CodexHistoryBase {
  readonly threadId: string;
  readonly endOrdinalExclusive: number;
  readonly endByteOffset: number;
}

const MAX_CODEX_HISTORY_DEPTH = 32;

/** Shared, read-only native rollout location strategy for conversation and lifecycle. */
export function locateCodexRolloutPaths(input: {
  readonly agentSessionId: number;
  readonly harnessSessionId?: string | null | undefined;
  readonly codexDirectory?: string | undefined;
  readonly discovery?: 'index_only' | 'full' | undefined;
}) {
  return Effect.gen(function* () {
    if (!input.harnessSessionId) return [];
    const codexDirectory = input.codexDirectory ?? join(homedir(), '.codex');
    const indexedPath = yield* indexedCodexRolloutPath({
      agentSessionId: input.agentSessionId,
      harnessSessionId: input.harnessSessionId,
      codexDirectory,
    });
    const paths: CodexRolloutPath[] = indexedPath
      ? [{ harnessSessionId: input.harnessSessionId, path: indexedPath }]
      : [];
    if (input.discovery !== 'index_only') {
      paths.push(
        ...(yield* discoverNativeRolloutPaths({
          agentSessionId: input.agentSessionId,
          harnessSessionId: input.harnessSessionId,
          codexDirectory,
        })),
      );
    }
    return paths;
  });
}

export function hookCodexRolloutPaths(
  streams: readonly [harnessSessionId: string, records: readonly HarnessObservationRecord[]][],
) {
  const paths: CodexRolloutPath[] = [];
  const seen = new Set<string>();
  for (const [harnessSessionId, records] of streams) {
    for (const record of records) {
      if (record.harness !== 'codex') continue;
      const transcriptPath = stringField(record.event, 'transcript_path');
      if (!transcriptPath || seen.has(transcriptPath)) continue;
      seen.add(transcriptPath);
      paths.push({ harnessSessionId, path: transcriptPath });
    }
  }
  return paths;
}

export function readCodexRolloutEntries(input: {
  readonly agentSessionId: number;
  readonly paths: readonly CodexRolloutPath[];
  readonly missingIsExpected: boolean;
}) {
  return Effect.gen(function* () {
    const entries: CodexRolloutEntry[] = [];
    const seenPaths = new Set<string>();
    let foundReadable = false;
    for (const rollout of input.paths) {
      if (seenPaths.has(rollout.path)) continue;
      seenPaths.add(rollout.path);
      const raw = yield* readRolloutFile({
        agentSessionId: input.agentSessionId,
        harnessSessionId: rollout.harnessSessionId,
        rolloutPath: rollout.path,
        missingIsExpected: input.missingIsExpected,
      });
      if (raw === null) continue;
      foundReadable = true;
      entries.push(...parseCodexRolloutEntries(raw));
    }
    return { entries, foundReadable };
  });
}

/** Reads paginated ancestors for conversation projection without widening lifecycle observation. */
export function readCodexConversationEntries(input: {
  readonly agentSessionId: number;
  readonly paths: readonly CodexRolloutPath[];
  readonly codexDirectory?: string | undefined;
  readonly missingIsExpected: boolean;
}) {
  return Effect.gen(function* () {
    const entries: CodexRolloutEntry[] = [];
    const seenPaths = new Set<string>();
    let foundReadable = false;
    for (const rollout of input.paths) {
      if (seenPaths.has(rollout.path)) continue;
      seenPaths.add(rollout.path);
      const raw = yield* readRolloutBuffer({
        agentSessionId: input.agentSessionId,
        harnessSessionId: rollout.harnessSessionId,
        rolloutPath: rollout.path,
        missingIsExpected: input.missingIsExpected,
      });
      if (raw === null) continue;
      foundReadable = true;
      entries.push(
        ...(yield* readCodexConversationPage({
          agentSessionId: input.agentSessionId,
          codexDirectory: input.codexDirectory,
          rollout,
          raw,
          visitedThreadIds: new Set([rollout.harnessSessionId]),
          depth: 0,
        })),
      );
    }
    return { entries, foundReadable };
  });
}

export function parseCodexRolloutEntries(raw: string): readonly CodexRolloutEntry[] {
  const entries: CodexRolloutEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        entries.push(parsed as CodexRolloutEntry);
      }
    } catch {
      // Native artifacts are version-sensitive and best effort. Callers expose
      // degraded state rather than inventing a lifecycle edge for this line.
    }
  }
  return entries;
}

function indexedCodexRolloutPath(input: {
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

function discoverNativeRolloutPaths(input: {
  readonly agentSessionId: number;
  readonly harnessSessionId: string;
  readonly codexDirectory: string;
}) {
  return Effect.gen(function* () {
    const candidates = yield* findRolloutFiles({
      directory: join(input.codexDirectory, 'sessions'),
      harnessSessionId: input.harnessSessionId,
      depthRemaining: 4,
    });
    const paths: CodexRolloutPath[] = [];
    for (const path of candidates) {
      const raw = yield* readRolloutFile({
        agentSessionId: input.agentSessionId,
        harnessSessionId: input.harnessSessionId,
        rolloutPath: path,
        missingIsExpected: true,
      });
      if (raw !== null && rolloutContainsSessionId(raw, input.harnessSessionId)) {
        paths.push({ harnessSessionId: input.harnessSessionId, path });
      }
    }
    return paths;
  });
}

function readCodexConversationPage(input: {
  readonly agentSessionId: number;
  readonly codexDirectory?: string | undefined;
  readonly rollout: CodexRolloutPath;
  readonly raw: Buffer;
  readonly visitedThreadIds: ReadonlySet<string>;
  readonly depth: number;
}): Effect.Effect<readonly CodexRolloutEntry[]> {
  return Effect.gen(function* () {
    const currentEntries = parseCodexRolloutEntries(input.raw.toString('utf8'));
    const historyBase = codexHistoryBase(currentEntries);
    if (!historyBase) return currentEntries;
    if (input.depth >= MAX_CODEX_HISTORY_DEPTH) {
      warnCodexHistory(input, historyBase, 'history_depth_exceeded');
      return currentEntries;
    }
    if (input.visitedThreadIds.has(historyBase.threadId)) {
      warnCodexHistory(input, historyBase, 'history_cycle');
      return currentEntries;
    }
    if (firstOrdinal(currentEntries) !== historyBase.endOrdinalExclusive) {
      warnCodexHistory(input, historyBase, 'history_ordinal_mismatch');
      return currentEntries;
    }

    const ancestorPaths = yield* locateCodexRolloutPaths({
      agentSessionId: input.agentSessionId,
      harnessSessionId: historyBase.threadId,
      codexDirectory: input.codexDirectory,
    });
    const seenPaths = new Set<string>();
    for (const ancestor of ancestorPaths) {
      if (seenPaths.has(ancestor.path)) continue;
      seenPaths.add(ancestor.path);
      const ancestorRaw = yield* readRolloutBuffer({
        agentSessionId: input.agentSessionId,
        harnessSessionId: ancestor.harnessSessionId,
        rolloutPath: ancestor.path,
        missingIsExpected: true,
      });
      if (ancestorRaw === null) continue;
      const prefix = codexHistoryPrefix(ancestorRaw, historyBase);
      if (!prefix) continue;
      const visitedThreadIds = new Set(input.visitedThreadIds);
      visitedThreadIds.add(historyBase.threadId);
      const ancestorEntries = yield* readCodexConversationPage({
        ...input,
        rollout: ancestor,
        raw: prefix,
        visitedThreadIds,
        depth: input.depth + 1,
      });
      return [...ancestorEntries, ...currentEntries];
    }

    warnCodexHistory(input, historyBase, 'history_base_unavailable');
    return currentEntries;
  });
}

function codexHistoryBase(entries: readonly CodexRolloutEntry[]): CodexHistoryBase | null {
  const sessionMeta = entries.find((entry) => entry.type === 'session_meta');
  const payload = object(sessionMeta?.payload);
  if (payload.history_mode !== 'paginated') return null;
  const historyBase = object(payload.history_base);
  const threadId = stringField(historyBase, 'thread_id');
  const endOrdinalExclusive = nonNegativeInteger(historyBase.end_ordinal_exclusive);
  const endByteOffset = positiveInteger(historyBase.end_byte_offset);
  return threadId && endOrdinalExclusive !== null && endByteOffset !== null
    ? { threadId, endOrdinalExclusive, endByteOffset }
    : null;
}

function codexHistoryPrefix(raw: Buffer, historyBase: CodexHistoryBase): Buffer | null {
  if (historyBase.endByteOffset > raw.byteLength) return null;
  const prefix = raw.subarray(0, historyBase.endByteOffset);
  if (prefix.at(-1) !== 0x0a) return null;
  const entries = parseCodexRolloutEntries(prefix.toString('utf8'));
  if (!rolloutHasSessionId(entries, historyBase.threadId)) return null;
  if (lastOrdinal(entries) !== historyBase.endOrdinalExclusive - 1) return null;
  return prefix;
}

function firstOrdinal(entries: readonly CodexRolloutEntry[]) {
  return entries.length > 0 ? nonNegativeInteger(entries[0]?.ordinal) : null;
}

function lastOrdinal(entries: readonly CodexRolloutEntry[]) {
  return entries.length > 0 ? nonNegativeInteger(entries.at(-1)?.ordinal) : null;
}

function rolloutHasSessionId(entries: readonly CodexRolloutEntry[], harnessSessionId: string) {
  return entries.some((entry) => {
    if (entry.type !== 'session_meta') return false;
    const payload = object(entry.payload);
    return payload.session_id === harnessSessionId || payload.id === harnessSessionId;
  });
}

function warnCodexHistory(
  input: { readonly agentSessionId: number; readonly rollout: CodexRolloutPath },
  historyBase: CodexHistoryBase,
  code:
    | 'history_base_unavailable'
    | 'history_cycle'
    | 'history_depth_exceeded'
    | 'history_ordinal_mismatch',
) {
  console.warn('[runtime] Codex paginated conversation history is degraded', {
    code,
    agentSessionId: input.agentSessionId,
    harnessSessionId: input.rollout.harnessSessionId,
    rolloutPath: input.rollout.path,
    historyBaseThreadId: historyBase.threadId,
  });
}

function findRolloutFiles(input: {
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
      if (
        entry.isFile() &&
        entry.name.endsWith(`${input.harnessSessionId}.jsonl`) &&
        entry.name.startsWith('rollout-')
      ) {
        paths.push(path);
      } else if (entry.isDirectory() && input.depthRemaining > 0) {
        paths.push(
          ...(yield* findRolloutFiles({
            ...input,
            directory: path,
            depthRemaining: input.depthRemaining - 1,
          })),
        );
      }
    }
    return paths;
  });
}

function readRolloutFile(input: {
  readonly agentSessionId: number;
  readonly harnessSessionId: string;
  readonly rolloutPath: string;
  readonly missingIsExpected: boolean;
}): Effect.Effect<string | null> {
  return readRolloutBuffer(input).pipe(Effect.map((raw) => raw?.toString('utf8') ?? null));
}

function readRolloutBuffer(input: {
  readonly agentSessionId: number;
  readonly harnessSessionId: string;
  readonly rolloutPath: string;
  readonly missingIsExpected: boolean;
}): Effect.Effect<Buffer | null> {
  return Effect.tryPromise({
    try: () => readFile(input.rolloutPath),
    catch: (error) => error,
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        if (input.missingIsExpected && isMissingFileError(error)) return null;
        console.warn('[runtime] Codex rollout could not be read', {
          agentSessionId: input.agentSessionId,
          harnessSessionId: input.harnessSessionId,
          rolloutPath: input.rolloutPath,
          error,
        });
        return null;
      }),
    ),
  );
}

function rolloutContainsSessionId(raw: string, harnessSessionId: string) {
  return rolloutHasSessionId(parseCodexRolloutEntries(raw), harnessSessionId);
}

function stringField(value: unknown, key: string) {
  const field = object(value)[key];
  return typeof field === 'string' && field ? field : null;
}

function nonNegativeInteger(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function positiveInteger(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isMissingFileError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function isMissingCodexIndexError(error: unknown) {
  return (
    isMissingFileError(error) ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'SQLITE_CANTOPEN')
  );
}
