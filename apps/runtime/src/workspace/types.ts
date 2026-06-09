import type { WorkspaceSnapshot } from '@isagi/contracts';

import type { EnvironmentFocusRow, SurfaceMetadataRow } from '../surfaces/index.js';

export type { EnvironmentFocusRow, SurfaceMetadataRow };

export type ProjectStatus = 'present' | 'missing';

export interface ProjectRow {
  readonly id: number;
  readonly name: string;
  readonly rootPath: string;
  readonly status: ProjectStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastSeenAt: string | null;
  readonly missingReason: string | null;
}

export interface WorktreeRow {
  readonly id: number;
  readonly projectId: number;
  readonly path: string;
  readonly branch: string | null;
  readonly head: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string | null;
}

export interface DiscoveredWorktree {
  readonly path: string;
  readonly branch: string | null;
  readonly head: string | null;
}

export type WorkspaceServiceSnapshot = WorkspaceSnapshot;
