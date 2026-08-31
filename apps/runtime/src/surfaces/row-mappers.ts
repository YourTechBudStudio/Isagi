import { type InferSelectModel } from 'drizzle-orm';
import { Effect } from 'effect';

import {
  type AgentSessionArtifactsService,
  type AgentSessionHarnessMetadataRead,
} from '../agent-sessions/harness/ledger.js';
import {
  agentSessions,
  ptyProcesses,
  surfacePanes,
  terminalSessions,
  worktreeEnvironmentStates,
  worktreeSurfaces,
} from '../persistence/schema.js';
import type { PtyProcessRow } from '../pty-processes/index.js';
import type {
  AgentSessionRow,
  EnvironmentFocusRow,
  SurfaceMetadataRow,
  SurfacePaneRow,
  SurfaceRow,
  TerminalSessionRow,
} from './types.js';

type WorktreeSurfaceRecord = InferSelectModel<typeof worktreeSurfaces>;
type SurfacePaneRecord = InferSelectModel<typeof surfacePanes>;
type PtyProcessRecord = InferSelectModel<typeof ptyProcesses>;
type AgentSessionRecord = InferSelectModel<typeof agentSessions>;
type TerminalSessionRecord = InferSelectModel<typeof terminalSessions>;
type EnvironmentFocusRecord = InferSelectModel<typeof worktreeEnvironmentStates>;

export function surfaceMetadataRow(row: WorktreeSurfaceRecord): SurfaceMetadataRow {
  return {
    id: row.id,
    worktreeId: row.worktreeId,
    title: row.title,
    paneKinds: [],
    sortOrder: row.sortOrder,
  };
}

export function surfaceRow(row: WorktreeSurfaceRecord): SurfaceRow {
  return {
    ...surfaceMetadataRow(row),
    layoutJson: row.layoutJson,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function paneRow(row: SurfacePaneRecord): SurfacePaneRow {
  return {
    id: row.id,
    surfaceId: row.surfaceId,
    title: row.title,
    sortOrder: row.sortOrder,
    sessionKind: row.sessionKind,
    sessionId: row.sessionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function ptyProcessRow(row: PtyProcessRecord | null): PtyProcessRow | null {
  if (!row) return null;
  return {
    id: row.id,
    backend: row.backend,
    backendRefJson: row.backendRefJson,
    command: row.command,
    args: decodeArgs(row.argsJson),
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

export function agentSessionRow(
  artifacts: AgentSessionArtifactsService,
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
      activePtyProcess: ptyProcessRow(process),
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
    activePtyProcess: ptyProcessRow(process),
  };
}

export function focusRow(row: EnvironmentFocusRecord): EnvironmentFocusRow {
  return {
    worktreeId: row.worktreeId,
    activeSurfaceId: row.activeSurfaceId,
    activePaneId: row.activePaneId,
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
