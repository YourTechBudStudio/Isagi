import { type InferSelectModel } from 'drizzle-orm';
import { Effect } from 'effect';

import {
  type AgentSessionHarnessMetadataRead,
  type AgentSessionArtifacts,
} from '../../harnesses/index.js';
import { ptyProcessRow } from '../../pty-processes/index.js';
import { ptyProcesses } from '../../pty-processes/tables.js';
import { agentSessions, terminalSessions } from '../tables.js';
import type { AgentSessionRow, TerminalSessionRow } from './types.js';

type PtyProcessRecord = InferSelectModel<typeof ptyProcesses>;
type AgentSessionRecord = InferSelectModel<typeof agentSessions>;
type TerminalSessionRecord = InferSelectModel<typeof terminalSessions>;

export function agentSessionRow(
  artifacts: AgentSessionArtifacts['Service'],
  row: AgentSessionRecord,
  process: PtyProcessRecord | null,
): Effect.Effect<AgentSessionRow> {
  return Effect.gen(function* () {
    const metadata = yield* artifacts.readMetadata(row.id);
    return {
      ...agentMetadataFields(metadata),
      id: row.id,
      worktreeId: row.worktreeId,
      harness: row.harness,
      cwd: row.cwd,
      activePtyProcessId: row.activePtyProcessId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastSeenAt: row.lastSeenAt,
      activePtyProcess: process ? ptyProcessRow(process) : null,
    };
  });
}

function agentMetadataFields(metadata: AgentSessionHarnessMetadataRead) {
  switch (metadata.status) {
    case 'valid':
      return {
        harnessSessionId: metadata.metadata.harnessSessionId,
        harnessMetadataStatus: 'valid' as const,
        harnessMetadataDiagnostic: null,
      };
    case 'missing':
      return {
        harnessSessionId: null,
        harnessMetadataStatus: 'missing' as const,
        harnessMetadataDiagnostic: `Harness metadata file is missing: ${metadata.metadataPath}`,
      };
    case 'invalid':
      return {
        harnessSessionId: null,
        harnessMetadataStatus: 'invalid' as const,
        harnessMetadataDiagnostic: metadata.diagnostic,
      };
  }
}

export function terminalSessionRow(
  row: TerminalSessionRecord,
  process: PtyProcessRecord | null,
): TerminalSessionRow {
  return {
    id: row.id,
    worktreeId: row.worktreeId,
    cwd: row.cwd,
    shellCommand: row.shellCommand,
    shellArgs: decodeArgs(row.shellArgsJson),
    shellArgsJson: row.shellArgsJson,
    activePtyProcessId: row.activePtyProcessId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    activePtyProcess: process ? ptyProcessRow(process) : null,
  };
}

function decodeArgs(json: string) {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
}
