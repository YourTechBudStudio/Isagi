import { homedir } from 'node:os';
import { join } from 'node:path';

import BetterSqlite from 'better-sqlite3';
import { Effect } from 'effect';

import type { HarnessObservationRecord } from '../projection.js';
import type { ConversationMessage } from '../types.js';

export function readOpenCodeConversation(input: {
  readonly agentSessionId: number;
  readonly cwd?: string | null | undefined;
  readonly harnessSessionId?: string | null | undefined;
  readonly opencodeDirectory?: string | undefined;
  readonly streams: readonly [
    harnessSessionId: string,
    records: readonly HarnessObservationRecord[],
  ][];
}): Effect.Effect<readonly ConversationMessage[]> {
  return Effect.gen(function* () {
    const sessionIds = openCodeSessionIds(input);
    if (sessionIds.length === 0) return [];
    const opencodeDirectory = input.opencodeDirectory ?? defaultOpenCodeDirectory();
    for (const harnessSessionId of sessionIds) {
      const rows = yield* readOpenCodeRows({
        agentSessionId: input.agentSessionId,
        harnessSessionId,
        opencodeDirectory,
      });
      if (!rows) continue;
      return conversationFromOpenCodeRows(rows);
    }
    return [];
  });
}

function openCodeSessionIds(input: {
  readonly harnessSessionId?: string | null | undefined;
  readonly streams: readonly [
    harnessSessionId: string,
    records: readonly HarnessObservationRecord[],
  ][];
}) {
  const ids: string[] = [];
  const seen = new Set<string>();
  const append = (id: string | null | undefined) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  append(input.harnessSessionId);
  for (const [harnessSessionId, records] of input.streams) {
    if (records[0]?.harness !== 'opencode') continue;
    append(harnessSessionId);
  }
  return ids;
}

function defaultOpenCodeDirectory() {
  const xdgDataHome = process.env.XDG_DATA_HOME;
  return xdgDataHome
    ? join(xdgDataHome, 'opencode')
    : join(homedir(), '.local', 'share', 'opencode');
}

interface OpenCodeRow {
  readonly messageId: string;
  readonly messageCreatedAt: number;
  readonly messageData: string;
  readonly partId: string | null;
  readonly partCreatedAt: number | null;
  readonly partData: string | null;
  readonly revert: string | null;
}

function readOpenCodeRows(input: {
  readonly agentSessionId: number;
  readonly harnessSessionId: string;
  readonly opencodeDirectory: string;
}) {
  return Effect.try({
    try: () => {
      const database = new BetterSqlite(join(input.opencodeDirectory, 'opencode.db'), {
        readonly: true,
        fileMustExist: true,
      });
      try {
        const session = database
          .prepare('select id from session where id = ? limit 1')
          .get(input.harnessSessionId);
        if (!session) return null;
        return database
          .prepare(
            `select
               m.id as messageId,
               m.time_created as messageCreatedAt,
               m.data as messageData,
               p.id as partId,
               p.time_created as partCreatedAt,
               p.data as partData,
               s.revert as revert
             from message m
             join session s on s.id = m.session_id
             left join part p on p.message_id = m.id
             where m.session_id = ?
             order by m.time_created, m.id, p.time_created, p.id`,
          )
          .all(input.harnessSessionId) as OpenCodeRow[];
      } finally {
        database.close();
      }
    },
    catch: (error) => error,
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        if (!isMissingDatabaseError(error)) {
          console.warn('[runtime] OpenCode conversation database could not be read', {
            agentSessionId: input.agentSessionId,
            harnessSessionId: input.harnessSessionId,
            opencodeDirectory: input.opencodeDirectory,
            error,
          });
        }
        return null;
      }),
    ),
  );
}

interface OpenCodeMessage {
  readonly id: string;
  readonly createdAt: number;
  readonly role: 'user' | 'assistant';
  readonly parts: readonly OpenCodePart[];
}

interface OpenCodePart {
  readonly id: string;
  readonly createdAt: number;
  readonly type: string;
  readonly text: string;
}

function conversationFromOpenCodeRows(
  rows: readonly OpenCodeRow[],
): readonly ConversationMessage[] {
  const messages = activeOpenCodeMessages(openCodeMessages(rows), revertMessageId(rows));
  const conversation: ConversationMessage[] = [];
  let assistantParts: ConversationMessage['parts'] = [];

  const flushAssistant = () => {
    if (assistantParts.length === 0) return;
    conversation.push({ role: 'assistant', parts: assistantParts });
    assistantParts = [];
  };

  for (const message of messages) {
    if (message.role === 'user') {
      flushAssistant();
      const parts = textParts(message.parts);
      if (parts.length > 0) conversation.push({ role: 'user', parts });
      continue;
    }

    assistantParts = [...assistantParts, ...textParts(message.parts)];
  }

  flushAssistant();
  return conversation;
}

function openCodeMessages(rows: readonly OpenCodeRow[]): readonly OpenCodeMessage[] {
  const byMessageId = new Map<string, OpenCodeMessage & { parts: OpenCodePart[] }>();
  for (const row of rows) {
    let message = byMessageId.get(row.messageId);
    if (!message) {
      const data = objectValue(parseJson(row.messageData));
      const role = data.role;
      if (role !== 'user' && role !== 'assistant') continue;
      message = {
        id: row.messageId,
        createdAt: row.messageCreatedAt,
        role,
        parts: [],
      };
      byMessageId.set(row.messageId, message);
    }

    if (!row.partId || row.partData === null || row.partCreatedAt === null) continue;
    const part = objectValue(parseJson(row.partData));
    const type = part.type;
    const text = part.text;
    if (typeof type !== 'string' || typeof text !== 'string') continue;
    message.parts.push({
      id: row.partId,
      createdAt: row.partCreatedAt,
      type,
      text,
    });
  }

  return [...byMessageId.values()]
    .map((message) => ({
      ...message,
      parts: [...message.parts].sort(
        (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
      ),
    }))
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

function activeOpenCodeMessages(
  messages: readonly OpenCodeMessage[],
  activeRevertMessageId: string | null,
) {
  if (!activeRevertMessageId) return messages;
  const revertIndex = messages.findIndex((message) => message.id === activeRevertMessageId);
  return revertIndex >= 0 ? messages.slice(0, revertIndex) : messages;
}

function revertMessageId(rows: readonly OpenCodeRow[]) {
  for (const row of rows) {
    const revert = objectValue(parseJson(row.revert));
    const messageId = revert.messageID;
    if (typeof messageId === 'string' && messageId) return messageId;
  }
  return null;
}

function textParts(parts: readonly OpenCodePart[]): ConversationMessage['parts'] {
  return parts.flatMap((part) =>
    part.type === 'text' && part.text ? [{ type: 'text' as const, text: part.text }] : [],
  );
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function isMissingDatabaseError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ((error as { readonly code?: unknown }).code === 'SQLITE_CANTOPEN' ||
      (error as { readonly code?: unknown }).code === 'ENOENT')
  );
}
