import { type InferSelectModel } from 'drizzle-orm';

import { ptyProcesses } from '../persistence/schema.js';
import type { PtyProcessRow } from './types.js';

type PtyProcessTableRow = InferSelectModel<typeof ptyProcesses>;

/**
 * The single decoder from the `pty_processes` table row to the domain row this
 * package owns (ADR 0005). Every domain that joins a process onto its own
 * durable entity — agent sessions, terminal sessions, commands, editor contexts
 * — reads it through here, so a column added to the table cannot reach three
 * projections and miss a fourth.
 */
export function ptyProcessRow(row: PtyProcessTableRow): PtyProcessRow {
  return {
    id: row.id,
    backend: row.backend,
    backendRefJson: row.backendRefJson,
    command: row.command,
    args: decodePtyArgs(row.argsJson),
    argsJson: row.argsJson,
    cwd: row.cwd,
    status: row.status,
    statusReason: row.statusReason,
    exitCode: row.exitCode,
    signal: row.signal,
    logMode: row.logMode,
    logPath: row.logPath,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    exitedAt: row.exitedAt,
    lastSeenAt: row.lastSeenAt,
  };
}

/**
 * Undecodable or non-array JSON yields an empty argument list rather than
 * failing the read. Preserved verbatim from the four implementations this
 * replaced: a process row whose args cannot be decoded is still a process whose
 * status, exit, and log the operator needs to see.
 */
function decodePtyArgs(json: string) {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
}
