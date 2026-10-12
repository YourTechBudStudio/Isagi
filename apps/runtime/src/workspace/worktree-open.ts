import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { Effect } from 'effect';

import type {
  ListProjectBranchesOutput,
  OpenWorktreeInput,
  OpenWorktreeOutput,
  WorktreeBaseRef,
  WorktreeSetupResult,
  WorktreeSetupTrustInput,
} from '@isagi/contracts';

import { CommandService } from '../commands/index.js';
import { diagnosticPhase } from '../platform/diagnostics/index.js';
import { branchPathHash, Git, listGitWorktrees, listLocalBranches } from '../platform/git/index.js';
import { DataDirectory } from '../platform/persistence/index.js';
import { ProjectRepository, type ProjectRow, type WorktreeRow } from '../projects/index.js';
import { createDetachedWorktree, type DetachedWorktreeInput } from './detached-worktree.js';
import { WorkspaceError } from './errors.js';
import { checkNewDirectory } from './new-directory.js';
import {
  ensureProjectPathAvailable,
  requireGitProject,
  requirePresentProject,
  requireUsableGitProject,
} from './project-guards.js';
import { reconciliation } from './reconcile.js';
import { WorktreeSetupRepository } from './setup/repository.js';
import { runPostCreateSetup } from './setup/runner.js';
import { WorktreeSetupService } from './setup/service.js';

type DiagnosticContext = Readonly<Record<string, string | number | null>>;

/**
 * Opening a worktree on a branch, and everything that decides whether it can be opened: listing branches, setup-hook
 * trust, the creation preflight, re-running setup, and the generic detached and new-directory primitives other
 * modules build on.
 */
export const worktreeOpen = Effect.gen(function* () {
  const repository = yield* ProjectRepository;
  const git = yield* Git;
  const dataDirectory = yield* DataDirectory;
  const commands = yield* CommandService;
  const worktreeSetup = yield* WorktreeSetupService;
  const worktreeSetupRepository = yield* WorktreeSetupRepository;
  const reconcile = yield* reconciliation;

  const listBranches = (project: ProjectRow) =>
    listLocalBranches(project.rootPath).pipe(Effect.provideService(Git, git));

  const validateBaseRef = Effect.fnUntraced(function* (project: ProjectRow, base: WorktreeBaseRef) {
    if (base.kind === 'branch') {
      const branches = yield* listBranches(project);
      if (!branches.includes(base.ref)) {
        return yield* new WorkspaceError({
          branch: base.ref,
          code: 'base_ref_not_found',
          message: `Base branch "${base.ref}" was not found in project ${project.id}.`,
          projectId: project.id,
        });
      }
      return base.ref;
    }

    if (base.kind === 'commit') {
      // Verified rather than trusted. The caller resolved this commit itself, possibly some time ago
      // and possibly against a different repository, and `git worktree add` would otherwise report a
      // stranger's mistake as a raw Git failure.
      const resolved = yield* resolveCommit(git, project, base.commit);
      if (resolved !== base.commit) {
        return yield* new WorkspaceError({
          branch: base.commit,
          code: 'base_ref_not_found',
          message: `Base commit "${base.commit}" did not resolve to itself in project ${project.id}.`,
          projectId: project.id,
        });
      }
      return resolved;
    }

    const worktree = yield* repository.findWorktree(base.worktreeId);
    if (!worktree || worktree.projectId !== project.id || worktree.branch || !worktree.head) {
      return yield* new WorkspaceError({
        code: 'base_ref_not_found',
        message: `Detached worktree ${base.worktreeId} was not found for project ${project.id}.`,
        projectId: project.id,
        worktreeId: base.worktreeId,
      });
    }

    const discovered = yield* listGitWorktrees(project.rootPath).pipe(
      Effect.provideService(Git, git),
    );
    const stillDetached = discovered.some(
      (candidate) =>
        candidate.path === worktree.path &&
        candidate.head === worktree.head &&
        candidate.branch === null &&
        !candidate.bare &&
        !candidate.prunable,
    );
    if (!stillDetached) {
      return yield* new WorkspaceError({
        code: 'base_ref_not_found',
        message: `Detached worktree ${base.worktreeId} is no longer available as a base for project ${project.id}.`,
        projectId: project.id,
        worktreeId: base.worktreeId,
      });
    }

    return worktree.head;
  });

  const ensureCheckoutPathAvailable = Effect.fnUntraced(function* (
    project: ProjectRow,
    branch: string,
    checkoutPath: string,
  ) {
    if (pathExists(checkoutPath)) {
      return yield* new WorkspaceError({
        branch,
        code: 'checkout_path_exists',
        message: `Worktree checkout path already exists: ${checkoutPath}`,
        path: checkoutPath,
        projectId: project.id,
      });
    }

    const registered = yield* listGitWorktrees(project.rootPath).pipe(
      Effect.provideService(Git, git),
    );
    if (registered.some((worktree) => worktree.path === checkoutPath)) {
      return yield* new WorkspaceError({
        branch,
        code: 'checkout_path_registered',
        message: `Worktree checkout path is still registered by Git: ${checkoutPath}. Run git worktree prune or remove the stale worktree, then try again.`,
        path: checkoutPath,
        projectId: project.id,
      });
    }
  });

  /**
   * Trust, then setup hooks, then post-create commands — the tail every newly usable checkout runs
   * through, whether it was just created by `openWorktree` or is being repaired by
   * `runWorktreeSetup`.
   *
   * Shared rather than copied: this sequence decides when hooks are allowed to run and when commands
   * follow them, and two copies of that decision would drift the moment one caller's rules change.
   * A failed setup deliberately stops before the command lifecycle — commands launched into a
   * half-prepared checkout are worse than no commands at all.
   */
  const completeWorktreeCreation = Effect.fnUntraced(function* (input: {
    readonly project: ProjectRow;
    readonly worktree: WorktreeRow;
    readonly setupPlan: WorktreeSetupPlan;
    readonly diagnosticContext: DiagnosticContext;
  }) {
    const { project, worktree, setupPlan } = input;
    if (setupPlan.status !== 'configured') {
      yield* commands.runPostCreateLifecycle({ worktreeId: worktree.id });
      return {
        status: 'skipped',
        reason: setupPlan.status === 'disabled' ? 'hooks_disabled' : 'not_configured',
      } as const;
    }

    const setup = yield* diagnosticPhase(
      'workspace.open_worktree.post_create_setup',
      { ...input.diagnosticContext, worktreeId: worktree.id, setupStatus: setupPlan.status },
      runPostCreateSetup({
        config: setupPlan.config,
        hash: setupPlan.hash,
        projectRootPath: project.rootPath,
        worktreeId: worktree.id,
        worktreePath: worktree.path,
      }).pipe(Effect.provideService(WorktreeSetupRepository, worktreeSetupRepository)),
    );

    if (setup.status === 'failed') return setup;
    yield* commands.runPostCreateLifecycle({ worktreeId: worktree.id });
    return setup;
  });

  return {
    listProjectBranches: Effect.fn('WorkspaceService.listProjectBranches')(function* (input: {
      readonly projectId: number;
    }) {
      const project = yield* requireUsableGitProject(repository, input.projectId);
      const branches = yield* listBranches(project);
      const worktrees = yield* repository.listWorktrees;
      const worktreeIdByBranch = new Map(
        worktrees
          .filter((worktree) => worktree.projectId === project.id && worktree.branch)
          .map((worktree) => [worktree.branch as string, worktree.id] as const),
      );

      return {
        branches: branches.map((branch) => ({
          name: branch,
          worktreeId: worktreeIdByBranch.get(branch) ?? null,
        })),
      } satisfies ListProjectBranchesOutput;
    }),
    preflightWorktreeSetup: Effect.fn('WorkspaceService.preflightWorktreeSetup')(function* (input: {
      readonly projectId: number;
    }) {
      const project = yield* requireUsableGitProject(repository, input.projectId);
      return yield* worktreeSetup.preflight(project);
    }),
    trustWorktreeSetup: Effect.fn('WorkspaceService.trustWorktreeSetup')(function* (input: {
      readonly projectId: number;
      readonly request: WorktreeSetupTrustInput;
    }) {
      const project = yield* requireUsableGitProject(repository, input.projectId);
      return yield* worktreeSetup.updateTrust({ project, request: input.request });
    }),
    openWorktree: Effect.fn('WorkspaceService.openWorktree')(
      function* (input: { readonly projectId: number; readonly request: OpenWorktreeInput }) {
        const project = yield* requirePresentProject(repository, input.projectId);
        yield* requireGitProject(project);
        const branch = input.request.branch.trim();
        const context = {
          projectId: project.id,
          rootPath: project.rootPath,
          branch,
        } as const;
        if (!branch) {
          return yield* new WorkspaceError({
            code: 'branch_not_found',
            message: 'A branch name is required to open a worktree.',
            projectId: input.projectId,
          });
        }

        yield* ensureProjectPathAvailable(repository, project);
        yield* validateBranchName(git, project, branch);
        yield* reconcile.reconcileProject(project);
        // Both collision checks sit after the service's own reconcile, so they judge what Git
        // actually holds rather than what the database last remembered.
        const createNew = input.request.mode === 'create_new';
        const existing = yield* repository.findProjectWorktreeByBranch({
          projectId: project.id,
          branch,
        });
        if (existing) {
          if (createNew) {
            return yield* new WorkspaceError({
              branch,
              code: 'worktree_exists',
              message: `Worktree ${existing.id} is already checked out on branch ${branch}.`,
              path: existing.path,
              projectId: project.id,
              worktreeId: existing.id,
            });
          }
          return {
            projectId: project.id,
            worktreeId: existing.id,
            branch,
            status: 'opened_existing',
            setup: { status: 'not_run', reason: 'existing_worktree' },
          } satisfies OpenWorktreeOutput;
        }

        const branches = yield* listBranches(project);
        const branchExists = branches.includes(branch);
        if (branchExists && createNew) {
          return yield* new WorkspaceError({
            branch,
            code: 'branch_exists',
            message: `Branch ${branch} already exists in project ${project.id}.`,
            projectId: project.id,
          });
        }
        let baseRef: string | null = null;
        if (!branchExists) {
          const base = input.request.base;
          if (!base) {
            return yield* new WorkspaceError({
              branch,
              code: 'new_branch_requires_base',
              message: `Branch ${branch} does not exist. Choose what to create it from.`,
              projectId: project.id,
            });
          }
          baseRef = yield* validateBaseRef(project, base);
        }

        const setupPlan = yield* worktreeSetup.validateTrustForOpen(project);

        const checkoutPath = checkoutPathForBranch(
          dataDirectory.paths.worktreesPath,
          project.id,
          branch,
        );
        const checkoutContext = { ...context, checkoutPath };
        yield* ensureCheckoutPathAvailable(project, branch, checkoutPath);
        yield* prepareCheckoutParent(project, branch, checkoutPath);

        if (branchExists) {
          yield* diagnosticPhase(
            'workspace.open_worktree.git_add_existing_branch',
            checkoutContext,
            git.run(['-C', project.rootPath, 'worktree', 'add', checkoutPath, branch]),
          );
        } else {
          if (!baseRef) {
            return yield* Effect.die(new Error('Base ref was validated but not available.'));
          }
          yield* diagnosticPhase(
            'workspace.open_worktree.git_add_new_branch',
            { ...checkoutContext, baseRef },
            git.run([
              '-C',
              project.rootPath,
              'worktree',
              'add',
              '-b',
              branch,
              checkoutPath,
              baseRef,
            ]),
          );
        }
        yield* diagnosticPhase(
          'workspace.open_worktree.reconcile_after_git_add',
          checkoutContext,
          reconcile.reconcileProject(project),
        );
        const created = yield* repository.findProjectWorktreeByBranch({
          projectId: project.id,
          branch,
        });
        if (!created) {
          return yield* new WorkspaceError({
            branch,
            code: 'worktree_not_found',
            message: `Git created branch ${branch}, but Isagi could not find the new worktree after reconciliation.`,
            projectId: project.id,
          });
        }

        const setup = yield* completeWorktreeCreation({
          project,
          worktree: created,
          setupPlan,
          diagnosticContext: checkoutContext,
        });

        // Branched rather than computed: `status` and `setup` are correlated members of the
        // output union, and a ternary would leave them independently widened.
        if (setup.status === 'failed') {
          return {
            projectId: project.id,
            worktreeId: created.id,
            branch,
            status: 'created_setup_failed',
            setup,
          } satisfies OpenWorktreeOutput;
        }

        return {
          projectId: project.id,
          worktreeId: created.id,
          branch,
          status: 'created',
          setup,
        } satisfies OpenWorktreeOutput;
      },
      (effect, input) =>
        diagnosticPhase(
          'workspace.open_worktree',
          { projectId: input.projectId, branch: input.request.branch.trim() },
          effect,
        ),
    ),
    createDetachedWorktree: Effect.fn('WorkspaceService.createDetachedWorktree')(function* (
      input: DetachedWorktreeInput,
    ) {
      return yield* createDetachedWorktree(
        { repository, git, reconcile: reconcile.reconcileProject },
        input,
      );
    }),
    checkNewDirectory: Effect.fn('WorkspaceService.checkNewDirectory')(function* (path: string) {
      return yield* checkNewDirectory(repository, path);
    }),
    preflightWorktreeCreation: Effect.fn('WorkspaceService.preflightWorktreeCreation')(
      function* (input: {
        readonly projectId: number;
        readonly branch: string;
        readonly fromRef: string;
      }) {
        const project = yield* requireUsableGitProject(repository, input.projectId);
        // Trimmed here as well as in `openWorktree`, because the checkout path is derived from
        // the branch name: an untrimmed name would hash to a different path than the creation
        // this preflight is answering for would use.
        const branch = input.branch.trim();
        yield* validateBranchName(git, project, branch);
        const branches = yield* listBranches(project);
        if (branches.includes(branch)) {
          return yield* new WorkspaceError({
            branch,
            code: 'branch_exists',
            message: `Branch ${branch} already exists in project ${project.id}.`,
            projectId: project.id,
          });
        }
        const existing = yield* repository.findProjectWorktreeByBranch({
          projectId: project.id,
          branch,
        });
        if (existing) {
          return yield* new WorkspaceError({
            branch,
            code: 'worktree_exists',
            message: `Worktree ${existing.id} is already checked out on branch ${branch}.`,
            path: existing.path,
            projectId: project.id,
            worktreeId: existing.id,
          });
        }
        const commit = yield* resolveCommit(git, project, input.fromRef);
        const checkoutPath = checkoutPathForBranch(
          dataDirectory.paths.worktreesPath,
          project.id,
          branch,
        );
        yield* ensureCheckoutPathAvailable(project, branch, checkoutPath);
        return { commit, checkoutPath };
      },
      (effect, input) =>
        diagnosticPhase(
          'workspace.preflight_worktree_creation',
          {
            projectId: input.projectId,
            branch: input.branch.trim(),
            fromRef: input.fromRef,
          },
          effect,
        ),
    ),
    runWorktreeSetup: Effect.fn('WorkspaceService.runWorktreeSetup')(
      function* (input: { readonly projectId: number; readonly worktreeId: number }) {
        const project = yield* requireUsableGitProject(repository, input.projectId);
        const worktree = yield* repository.findProjectWorktree({
          projectId: project.id,
          worktreeId: input.worktreeId,
        });
        if (!worktree) {
          return yield* new WorkspaceError({
            code: 'worktree_not_found',
            message: `Worktree ${input.worktreeId} was not found in project ${project.id}.`,
            projectId: project.id,
            worktreeId: input.worktreeId,
          });
        }
        const setupPlan = yield* worktreeSetup.validateTrustForOpen(project);
        const setup: Exclude<WorktreeSetupResult, { status: 'not_run' }> =
          yield* completeWorktreeCreation({
            project,
            worktree,
            setupPlan,
            diagnosticContext: {
              projectId: project.id,
              rootPath: project.rootPath,
              branch: worktree.branch,
            },
          });
        return setup;
      },
      (effect, input) =>
        diagnosticPhase(
          'workspace.run_worktree_setup',
          { projectId: input.projectId, worktreeId: input.worktreeId },
          effect,
        ),
    ),
  };
});

type WorktreeSetupPlan = Effect.Success<
  ReturnType<WorktreeSetupService['Service']['validateTrustForOpen']>
>;

function validateBranchName(git: Git['Service'], project: ProjectRow, branch: string) {
  return git.run(['-C', project.rootPath, 'check-ref-format', '--branch', branch]).pipe(
    Effect.asVoid,
    Effect.catchTag('GitCommandError', () =>
      Effect.fail(
        new WorkspaceError({
          branch,
          code: 'invalid_branch_name',
          message: `Branch name "${branch}" is not valid for Git.`,
          projectId: project.id,
        }),
      ),
    ),
  );
}

/**
 * The commit a ref names, as Git resolves it.
 *
 * `^{commit}` makes an annotated tag or any other peelable object answer with the commit it points
 * at, and `--end-of-options` stops a ref that begins with a dash from being read as a flag. Shared
 * by the creation preflight and by `validateBaseRef`'s commit branch so the two cannot disagree
 * about what a ref resolves to, or about which refs resolve at all.
 */
function resolveCommit(git: Git['Service'], project: ProjectRow, ref: string) {
  return git
    .run(['-C', project.rootPath, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])
    .pipe(
      Effect.map(({ stdout }) => stdout.trim()),
      Effect.catchTag('GitCommandError', () =>
        Effect.fail(
          new WorkspaceError({
            branch: ref,
            code: 'base_ref_not_found',
            message: `Base ref "${ref}" was not found in project ${project.id}.`,
            projectId: project.id,
          }),
        ),
      ),
    );
}

function checkoutPathForBranch(worktreesPath: string, projectId: number, branch: string) {
  return join(worktreesPath, String(projectId), branchPathHash(branch));
}

function prepareCheckoutParent(project: ProjectRow, branch: string, checkoutPath: string) {
  return Effect.try({
    try: () => mkdirSync(dirname(checkoutPath), { recursive: true }),
    catch: () =>
      new WorkspaceError({
        branch,
        code: 'checkout_parent_unavailable',
        message: `Could not prepare the worktree checkout directory for project ${project.id}.`,
        path: checkoutPath,
        projectId: project.id,
      }),
  });
}

function pathExists(path: string) {
  try {
    return existsSync(path);
  } catch {
    return true;
  }
}
