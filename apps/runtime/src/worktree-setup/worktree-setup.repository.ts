import { and, desc, eq, type InferSelectModel } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import { DatabaseError, RuntimeDatabase } from '../persistence/index.js';
import {
  worktreeSetupRuns,
  worktreeSetupSteps,
  worktreeSetupTrust,
} from '../persistence/schema.js';

export type WorktreeSetupTrustRow = InferSelectModel<typeof worktreeSetupTrust>;
export type WorktreeSetupRunRow = InferSelectModel<typeof worktreeSetupRuns>;
export type WorktreeSetupStepRow = InferSelectModel<typeof worktreeSetupSteps>;

export interface CreateSetupRunInput {
  readonly hookConfigHash: string;
  readonly lifecycle: 'post_create';
  readonly status: 'succeeded' | 'failed';
  readonly worktreeId: number;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface CreateSetupStepInput {
  readonly runId: number;
  readonly hookIndex: number;
  readonly hookType: 'copy' | 'symlink' | 'command';
  readonly status: 'succeeded' | 'failed' | 'skipped';
  readonly startedAt: string;
  readonly completedAt: string;
  readonly message?: string | null | undefined;
  readonly command?: string | null | undefined;
  readonly src?: string | null | undefined;
  readonly dest?: string | null | undefined;
  readonly exitCode?: number | null | undefined;
  readonly signal?: string | null | undefined;
  readonly stdoutExcerpt?: string | null | undefined;
  readonly stderrExcerpt?: string | null | undefined;
}

export interface WorktreeSetupRepositoryService {
  readonly findTrust: (input: {
    readonly projectId: number;
    readonly scope: 'post_create';
  }) => Effect.Effect<WorktreeSetupTrustRow | null, DatabaseError>;
  readonly setTrustedHash: (input: {
    readonly alwaysTrustProject: boolean;
    readonly hash: string;
    readonly projectId: number;
    readonly scope: 'post_create';
  }) => Effect.Effect<void, DatabaseError>;
  readonly disableHooks: (input: {
    readonly projectId: number;
    readonly scope: 'post_create';
  }) => Effect.Effect<void, DatabaseError>;
  readonly createRunWithSteps: (input: {
    readonly run: CreateSetupRunInput;
    readonly steps: readonly Omit<CreateSetupStepInput, 'runId'>[];
  }) => Effect.Effect<number, DatabaseError>;
  readonly listRunSteps: (runId: number) => Effect.Effect<WorktreeSetupStepRow[], DatabaseError>;
}

export const WorktreeSetupRepository = Context.GenericTag<WorktreeSetupRepositoryService>(
  'isagi/WorktreeSetupRepository',
);

export const WorktreeSetupRepositoryLive = Layer.effect(
  WorktreeSetupRepository,
  Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    return {
      findTrust: (input) =>
        database.use(
          'find_worktree_setup_trust',
          (db) =>
            db
              .select()
              .from(worktreeSetupTrust)
              .where(
                and(
                  eq(worktreeSetupTrust.projectId, input.projectId),
                  eq(worktreeSetupTrust.scope, input.scope),
                ),
              )
              .get() ?? null,
        ),
      setTrustedHash: (input) =>
        database.use('set_worktree_setup_trust_hash', (db) => {
          const now = timestamp();
          const existing = db
            .select({ id: worktreeSetupTrust.id })
            .from(worktreeSetupTrust)
            .where(
              and(
                eq(worktreeSetupTrust.projectId, input.projectId),
                eq(worktreeSetupTrust.scope, input.scope),
              ),
            )
            .get();
          const values = {
            trustedHash: input.hash,
            alwaysTrustProject: input.alwaysTrustProject,
            hooksDisabled: false,
            updatedAt: now,
          };
          if (existing) {
            db.update(worktreeSetupTrust)
              .set(values)
              .where(eq(worktreeSetupTrust.id, existing.id))
              .run();
          } else {
            db.insert(worktreeSetupTrust)
              .values({
                projectId: input.projectId,
                scope: input.scope,
                ...values,
                createdAt: now,
              })
              .run();
          }
        }),
      disableHooks: (input) =>
        database.use('disable_worktree_setup_hooks', (db) => {
          const now = timestamp();
          const existing = db
            .select({ id: worktreeSetupTrust.id })
            .from(worktreeSetupTrust)
            .where(
              and(
                eq(worktreeSetupTrust.projectId, input.projectId),
                eq(worktreeSetupTrust.scope, input.scope),
              ),
            )
            .get();
          const values = {
            trustedHash: null,
            alwaysTrustProject: false,
            hooksDisabled: true,
            updatedAt: now,
          };
          if (existing) {
            db.update(worktreeSetupTrust)
              .set(values)
              .where(eq(worktreeSetupTrust.id, existing.id))
              .run();
          } else {
            db.insert(worktreeSetupTrust)
              .values({
                projectId: input.projectId,
                scope: input.scope,
                ...values,
                createdAt: now,
              })
              .run();
          }
        }),
      createRunWithSteps: (input) =>
        database.transaction('create_worktree_setup_run_with_steps', (db) => {
          const run = db
            .insert(worktreeSetupRuns)
            .values(input.run)
            .returning({ id: worktreeSetupRuns.id })
            .get();
          for (const step of input.steps) {
            db.insert(worktreeSetupSteps)
              .values({ ...step, runId: run.id })
              .run();
          }
          return run.id;
        }),
      listRunSteps: (runId) =>
        database.use('list_worktree_setup_run_steps', (db) =>
          db
            .select()
            .from(worktreeSetupSteps)
            .where(eq(worktreeSetupSteps.runId, runId))
            .orderBy(worktreeSetupSteps.hookIndex, desc(worktreeSetupSteps.id))
            .all(),
        ),
    } satisfies WorktreeSetupRepositoryService;
  }),
);

function timestamp() {
  return new Date().toISOString();
}
