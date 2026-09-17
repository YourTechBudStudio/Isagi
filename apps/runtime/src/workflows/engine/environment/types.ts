import type { Effect } from 'effect';

import type { WorkflowPlacementRequestDto, WorkflowPlacementSource } from '@isagi/contracts';

import type { SurfaceRepositoryService, SurfaceServiceShape } from '../../../surfaces/index.js';
import type { WorkspaceServiceShape } from '../../../workspace/index.js';
import type { WorkspaceRepositoryService } from '../../../workspace/workspace.repository.js';
import type { WorkflowAttemptRecord, WorkflowRunRecord } from '../../persistence/records.js';
import type { WorkflowRunsRepositoryService } from '../../persistence/runs.repository.js';

export type { WorkflowPlacementSource };

/**
 * A placement request and who decided it.
 *
 * The request is what was *asked for*. Nothing here has been checked against a live row yet — that
 * is `resolvePlacement`'s job, and keeping the two apart is what lets the durable record say both
 * "this is what was requested" and "this is what the launch made of it".
 */
export interface PlacementSelection {
  readonly source: WorkflowPlacementSource;
  readonly request: WorkflowPlacementRequestDto;
}

/**
 * Everything preparation acts on, decided at launch and never re-derived.
 *
 * Deliberately resolved rather than requested: a `create` worktree already carries the commit its
 * `fromRef` pointed at and the checkout path Isagi derived, so preparation creates from a decision
 * that was recorded before anything was allocated — even if the branch has moved since.
 */
export interface ResolvedPlacement extends PlacementSelection {
  readonly projectId: number;
  readonly worktree:
    | { readonly kind: 'reuse'; readonly worktreeId: number; readonly worktreePath: string }
    | {
        readonly kind: 'create';
        readonly branch: string;
        readonly fromRef: string;
        readonly baseCommit: string;
        readonly checkoutPath: string;
      };
  readonly surface:
    | { readonly kind: 'reuse'; readonly surfaceId: number }
    /** Already trimmed and validated by `validateSurfaceTitle`. */
    | { readonly kind: 'create'; readonly title: string };
}

/** The project a launch belongs to, as selection and validation need it. */
export interface LaunchProject {
  readonly id: number;
  readonly name: string;
  readonly kind: 'git' | 'folder';
  readonly rootPath: string;
}

/**
 * What the preparation segment needs.
 *
 * Narrowed to the operations it actually performs rather than handed whole services, because the
 * list is the clearest statement of what preparation is allowed to do: read placement rows, and
 * mutate only through the owning services (ADR 0008).
 */
export interface PreparationDeps {
  readonly runs: WorkflowRunsRepositoryService;
  readonly workspace: Pick<
    WorkspaceRepositoryService,
    'findWorktree' | 'findProject' | 'findProjectWorktreeByBranch'
  >;
  readonly workspaceService: Pick<WorkspaceServiceShape, 'openWorktree' | 'runWorktreeSetup'>;
  readonly surfaceRepository: Pick<SurfaceRepositoryService, 'findSurface'>;
  readonly surfaces: Pick<SurfaceServiceShape, 'createSinglePaneSurface'>;
  readonly owner: string;
  readonly ownerIncarnation: string;
  readonly poke: Effect.Effect<void>;
}

/** The run and the claimed attempt preparation holds for the whole of its work. */
export interface PreparationContext {
  readonly run: WorkflowRunRecord;
  readonly attempt: WorkflowAttemptRecord;
}
