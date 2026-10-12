import { type InferSelectModel } from 'drizzle-orm';

import { surfacePanes, worktreeEnvironmentStates, worktreeSurfaces } from '../tables.js';
import type {
  EnvironmentFocusRow,
  SurfaceMetadataRow,
  SurfacePaneRow,
  SurfaceRow,
} from './types.js';

type WorktreeSurfaceRecord = InferSelectModel<typeof worktreeSurfaces>;
type SurfacePaneRecord = InferSelectModel<typeof surfacePanes>;
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

export function focusRow(row: EnvironmentFocusRecord): EnvironmentFocusRow {
  return {
    worktreeId: row.worktreeId,
    activeSurfaceId: row.activeSurfaceId,
    activePaneId: row.activePaneId,
  };
}
