import type { WorkflowPlacementRequestDto, WorkflowPlacementSource } from '@isagi/contracts';

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
 * `fromRef` pointed at, so preparation and its Retry create from the commit recorded at launch, even
 * if the ref has moved since.
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
