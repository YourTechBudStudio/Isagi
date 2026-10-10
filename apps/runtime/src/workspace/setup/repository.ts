import { and, desc, eq, type InferSelectModel } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import {
  DatabaseError,
  RuntimeDatabase,
  type RuntimeDrizzleDatabase,
} from '../../platform/persistence/index.js';
import { worktreeSetupRuns, worktreeSetupSteps, worktreeSetupTrust } from '../tables.js';

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
  readonly outputExcerpt?: string | null | undefined;
}

const make = Effect.gen(function* () {
  const database = yield* RuntimeDatabase;
  return WorktreeSetupRepository.of({
    findTrust: Effect.fn('WorktreeSetupRepository.findTrust')(function* (input) {
      return yield* database.use(
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
      );
    }),
    setTrustedHash: Effect.fn('WorktreeSetupRepository.setTrustedHash')(function* (input) {
      return yield* database.use('set_worktree_setup_trust_hash', (db) =>
        upsertTrust(db, input, {
          trustedHash: input.hash,
          alwaysTrustProject: input.alwaysTrustProject,
          hooksDisabled: false,
        }),
      );
    }),
    disableHooks: Effect.fn('WorktreeSetupRepository.disableHooks')(function* (input) {
      return yield* database.use('disable_worktree_setup_hooks', (db) =>
        upsertTrust(db, input, {
          trustedHash: null,
          alwaysTrustProject: false,
          hooksDisabled: true,
        }),
      );
    }),
    createRunWithSteps: Effect.fn('WorktreeSetupRepository.createRunWithSteps')(function* (input) {
      return yield* database.transaction('create_worktree_setup_run_with_steps', (db) => {
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
      });
    }),
    listRunSteps: Effect.fn('WorktreeSetupRepository.listRunSteps')(function* (runId) {
      return yield* database.use('list_worktree_setup_run_steps', (db) =>
        db
          .select()
          .from(worktreeSetupSteps)
          .where(eq(worktreeSetupSteps.runId, runId))
          .orderBy(worktreeSetupSteps.hookIndex, desc(worktreeSetupSteps.id))
          .all(),
      );
    }),
  });
});

/** Writes the project's trust row for `scope`, creating it on first use. */
function upsertTrust(
  db: RuntimeDrizzleDatabase,
  target: { readonly projectId: number; readonly scope: 'post_create' },
  trust: {
    readonly trustedHash: string | null;
    readonly alwaysTrustProject: boolean;
    readonly hooksDisabled: boolean;
  },
) {
  const now = timestamp();
  const existing = db
    .select({ id: worktreeSetupTrust.id })
    .from(worktreeSetupTrust)
    .where(
      and(
        eq(worktreeSetupTrust.projectId, target.projectId),
        eq(worktreeSetupTrust.scope, target.scope),
      ),
    )
    .get();
  const values = { ...trust, updatedAt: now };
  if (existing) {
    db.update(worktreeSetupTrust).set(values).where(eq(worktreeSetupTrust.id, existing.id)).run();
  } else {
    db.insert(worktreeSetupTrust)
      .values({ projectId: target.projectId, scope: target.scope, ...values, createdAt: now })
      .run();
  }
}

export class WorktreeSetupRepository extends Context.Service<
  WorktreeSetupRepository,
  {
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
>()('isagi/runtime/workspace/WorktreeSetupRepository') {
  static readonly layer = Layer.effect(WorktreeSetupRepository, make);
}

function timestamp() {
  return new Date().toISOString();
}
