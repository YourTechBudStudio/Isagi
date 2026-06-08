import { Context, Data, Effect, Layer } from 'effect';

import type {
  WorktreeSetupPreflightOutput,
  WorktreeSetupTrustInput,
  WorktreeSetupTrustOutput,
} from '@isagi/contracts';

import type { DatabaseError } from '../persistence/index.js';
import type { WorktreeHooksConfig } from '../project-config/project-config.schema.js';
import { ProjectConfigError, loadWorktreeHooks } from '../project-config/project-config.service.js';
import type { ProjectRow } from '../workspace/types.js';
import { WorktreeSetupRepository } from './worktree-setup.repository.js';

export class WorktreeSetupError extends Data.TaggedError('WorktreeSetupError')<{
  readonly code:
    | 'setup_not_configured'
    | 'setup_config_invalid'
    | 'setup_trust_required'
    | 'setup_trust_mismatch';
  readonly message: string;
  readonly hash?: string | undefined;
  readonly projectId?: number | undefined;
  readonly cause?: unknown;
}> {}

export type WorktreeSetupServiceError = DatabaseError | ProjectConfigError | WorktreeSetupError;

export interface WorktreeSetupService {
  readonly preflight: (
    project: ProjectRow,
  ) => Effect.Effect<WorktreeSetupPreflightOutput, WorktreeSetupServiceError>;
  readonly updateTrust: (input: {
    readonly project: ProjectRow;
    readonly request: WorktreeSetupTrustInput;
  }) => Effect.Effect<WorktreeSetupTrustOutput, WorktreeSetupServiceError>;
  readonly validateTrustForOpen: (project: ProjectRow) => Effect.Effect<
    | { readonly status: 'disabled' }
    | { readonly status: 'not_configured' }
    | {
        readonly status: 'configured';
        readonly hash: string;
        readonly config: WorktreeHooksConfig;
      },
    WorktreeSetupServiceError
  >;
}

export const WorktreeSetupService = Context.GenericTag<WorktreeSetupService>(
  'isagi/WorktreeSetupService',
);

export const WorktreeSetupServiceLive = Layer.effect(
  WorktreeSetupService,
  Effect.gen(function* () {
    const repository = yield* WorktreeSetupRepository;
    return {
      preflight: (project) =>
        Effect.gen(function* () {
          const trust = yield* repository.findTrust({
            projectId: project.id,
            scope: 'post_create',
          });
          if (trust?.hooksDisabled) {
            return {
              projectId: project.id,
              status: 'disabled',
              summary: [],
            } satisfies WorktreeSetupPreflightOutput;
          }
          const hooks = yield* loadWorktreeHooks({
            projectId: project.id,
            rootPath: project.rootPath,
          });
          if (hooks.status === 'not_configured') {
            return {
              projectId: project.id,
              status: 'not_configured',
              summary: [],
            } satisfies WorktreeSetupPreflightOutput;
          }
          return {
            projectId: project.id,
            status: trustStatus(trust, hooks.hash),
            hash: hooks.hash,
            summary: hooks.summary,
          } satisfies WorktreeSetupPreflightOutput;
        }),
      updateTrust: (input) =>
        Effect.gen(function* () {
          if (input.request.action === 'disable_hooks') {
            yield* repository.disableHooks({ projectId: input.project.id, scope: 'post_create' });
            return {
              projectId: input.project.id,
              status: 'disabled',
            } satisfies WorktreeSetupTrustOutput;
          }
          const hooks = yield* loadWorktreeHooks({
            projectId: input.project.id,
            rootPath: input.project.rootPath,
          });
          if (hooks.status === 'not_configured') {
            return yield* Effect.fail(
              new WorktreeSetupError({
                code: 'setup_not_configured',
                message: 'This project does not have worktree setup hooks configured.',
                projectId: input.project.id,
              }),
            );
          }
          if (hooks.hash !== input.request.hash) {
            return yield* Effect.fail(
              new WorktreeSetupError({
                code: 'setup_trust_mismatch',
                message: 'The worktree setup hooks changed before trust could be saved.',
                hash: hooks.hash,
                projectId: input.project.id,
              }),
            );
          }
          yield* repository.setTrustedHash({
            alwaysTrustProject: input.request.action === 'always_trust_project',
            hash: hooks.hash,
            projectId: input.project.id,
            scope: 'post_create',
          });
          return {
            projectId: input.project.id,
            status: input.request.action === 'always_trust_project' ? 'always_trusted' : 'trusted',
            hash: hooks.hash,
          } satisfies WorktreeSetupTrustOutput;
        }),
      validateTrustForOpen: (project) =>
        Effect.gen(function* () {
          const trust = yield* repository.findTrust({
            projectId: project.id,
            scope: 'post_create',
          });
          if (trust?.hooksDisabled) {
            return { status: 'disabled' as const };
          }
          const hooks = yield* loadWorktreeHooks({
            projectId: project.id,
            rootPath: project.rootPath,
          });
          if (hooks.status === 'not_configured') {
            return { status: 'not_configured' as const };
          }
          if (!trust?.alwaysTrustProject && trust?.trustedHash !== hooks.hash) {
            return yield* Effect.fail(
              new WorktreeSetupError({
                code: 'setup_trust_required',
                message:
                  'Approve this project’s worktree setup hooks before creating the worktree.',
                hash: hooks.hash,
                projectId: project.id,
              }),
            );
          }
          return { status: 'configured' as const, hash: hooks.hash, config: hooks.config };
        }),
    } satisfies WorktreeSetupService;
  }),
);

function trustStatus(
  trust: { readonly alwaysTrustProject: boolean; readonly trustedHash: string | null } | null,
  hash: string,
) {
  if (trust?.alwaysTrustProject) {
    return 'always_trusted' as const;
  }
  if (trust?.trustedHash === hash) {
    return 'trusted' as const;
  }
  return 'needs_approval' as const;
}
