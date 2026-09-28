import assert from 'node:assert/strict';
import test, { after as afterAll, describe } from 'node:test';

import { Effect } from 'effect';

import { WorktreeSetupError } from '../../worktree-setup/index.js';
import type { WorktreeSetupService } from '../../worktree-setup/worktree-setup.service.js';
import { WorkspaceError, WorkspaceService } from '../workspace.service.js';
import { createGitProjectFixture, withRegisteredGitProject } from './live-git-support.js';
import type { LiveWorkspaceOptions } from './live-workspace-support.js';
import { testWorktreeSetup, testWorktreeSetupRepository } from './test-support.js';

/**
 * `runWorktreeSetup` re-runs the tail of worktree creation against a worktree that already exists,
 * so a preparation that failed at setup can be retried without creating a second checkout.
 *
 * The worktree is real, because the hooks and commands run inside it. Trust and hook configuration
 * are stubbed, because they live in trust rows and project config rather than in Git, and
 * `setup_trust_required` has no expressible form in a repository at all.
 */

const fixture = createGitProjectFixture('worktree-setup-rerun');
afterAll(() => {
  fixture.cleanup();
});

type TrustPlan = Effect.Effect.Success<ReturnType<WorktreeSetupService['validateTrustForOpen']>>;
type TrustAnswer = Effect.Effect<TrustPlan, WorktreeSetupError>;

/**
 * A harness whose trust answer can change between the creation and the re-run.
 *
 * That ordering is the point: every case here creates the worktree with hooks off and then asks
 * what a *re-run* does, which is how the real sequence goes — a person approves hooks, or fixes
 * them, after a preparation has already failed at setup.
 */
function recordingHarness() {
  const lifecycleRuns: number[] = [];
  let trust: TrustAnswer = Effect.succeed({ status: 'not_configured' as const });
  let setupRunId = 1;
  return {
    lifecycleRuns,
    answerTrustWith: (next: TrustAnswer) => {
      trust = next;
    },
    recordSetupRunAs: (next: number) => {
      setupRunId = next;
    },
    options: {
      commands: {
        runPostCreateLifecycle: (input: { readonly worktreeId: number }) =>
          Effect.sync(() => {
            lifecycleRuns.push(input.worktreeId);
          }),
      },
      worktreeSetup: { ...testWorktreeSetup, validateTrustForOpen: () => trust },
      worktreeSetupRepository: {
        ...testWorktreeSetupRepository,
        createRunWithSteps: () => Effect.succeed(setupRunId),
      },
    } satisfies LiveWorkspaceOptions,
  };
}

function configuredHooks(...postCreate: readonly string[]): TrustAnswer {
  return Effect.succeed({
    status: 'configured' as const,
    hash: 'hash-1',
    config: {
      postCreate: postCreate.map((run) => ({
        type: 'command' as const,
        run,
        cwd: '.',
        timeout: '30s',
        env: {},
      })),
    },
  });
}

/**
 * Creates a worktree with hooks off — so the creation's own setup is a no-op and its lifecycle run
 * is the only one on the record — then hands `rerun` the worktree it made.
 */
function withWorktreeThenRerun<A, E>(
  label: string,
  harness: ReturnType<typeof recordingHarness>,
  rerun: (input: {
    readonly service: Effect.Effect.Success<typeof WorkspaceService>;
    readonly projectId: number;
    readonly worktreeId: number;
  }) => Effect.Effect<A, E>,
) {
  const branch = `feature/${label}`;
  return withRegisteredGitProject(label, fixture.rootPath, harness.options, (projectId) =>
    Effect.gen(function* () {
      const service = yield* WorkspaceService;
      const opened = yield* service.openWorktree({
        projectId,
        request: { branch, base: { kind: 'branch', ref: 'main' }, mode: 'create_new' },
      });
      assert.equal(opened.status, 'created');
      assert.deepEqual(harness.lifecycleRuns, [opened.worktreeId]);
      return yield* rerun({ service, projectId, worktreeId: opened.worktreeId });
    }),
  );
}

describe('runWorktreeSetup', () => {
  test('a worktree that does not belong to the project is worktree_not_found', async () => {
    const harness = recordingHarness();
    const error = await withWorktreeThenRerun(
      'setup-missing-worktree',
      harness,
      ({ service, projectId }) =>
        service.runWorktreeSetup({ projectId, worktreeId: 9_999 }).pipe(Effect.flip),
    );

    assert.ok(error instanceof WorkspaceError);
    assert.equal(error.code, 'worktree_not_found');
    assert.equal(error.worktreeId, 9_999);
  });

  test('hooks that are not configured are skipped, and commands still run', async () => {
    const harness = recordingHarness();
    const result = await withWorktreeThenRerun(
      'setup-not-configured',
      harness,
      ({ service, projectId, worktreeId }) => service.runWorktreeSetup({ projectId, worktreeId }),
    );

    assert.deepEqual(result, { status: 'skipped', reason: 'not_configured' });
    // Once for the creation, once for the re-run: re-establishing the environment is what the
    // caller is asking for, and `runCommand` is what declines to start a command twice.
    assert.equal(harness.lifecycleRuns.length, 2);
    assert.equal(harness.lifecycleRuns[0], harness.lifecycleRuns[1]);
  });

  test('hooks that are disabled are skipped with their own reason', async () => {
    const harness = recordingHarness();
    const result = await withWorktreeThenRerun(
      'setup-disabled',
      harness,
      ({ service, projectId, worktreeId }) => {
        harness.answerTrustWith(Effect.succeed({ status: 'disabled' as const }));
        return service.runWorktreeSetup({ projectId, worktreeId });
      },
    );

    assert.deepEqual(result, { status: 'skipped', reason: 'hooks_disabled' });
    assert.equal(harness.lifecycleRuns.length, 2);
  });

  test('untrusted hooks fail with setup_trust_required and run no commands', async () => {
    const harness = recordingHarness();
    const error = await withWorktreeThenRerun(
      'setup-trust-required',
      harness,
      ({ service, projectId, worktreeId }) => {
        harness.answerTrustWith(
          Effect.fail(
            new WorktreeSetupError({
              code: 'setup_trust_required',
              message: 'Approve this project’s worktree setup hooks.',
            }),
          ),
        );
        return service.runWorktreeSetup({ projectId, worktreeId }).pipe(Effect.flip);
      },
    );

    assert.ok(error instanceof WorktreeSetupError);
    assert.equal(error.code, 'setup_trust_required');
    // Only the creation's own lifecycle run. Nothing about this worktree was re-established.
    assert.equal(harness.lifecycleRuns.length, 1);
  });

  test('a hook that succeeds returns the run id and then runs commands', async () => {
    const harness = recordingHarness();
    const result = await withWorktreeThenRerun(
      'setup-succeeded',
      harness,
      ({ service, projectId, worktreeId }) => {
        harness.answerTrustWith(configuredHooks('true'));
        harness.recordSetupRunAs(42);
        return service.runWorktreeSetup({ projectId, worktreeId });
      },
    );

    assert.deepEqual(result, { status: 'succeeded', runId: 42 });
    assert.equal(harness.lifecycleRuns.length, 2);
  });

  test('a hook that fails returns the failure and stops before the command lifecycle', async () => {
    const harness = recordingHarness();
    const result = await withWorktreeThenRerun(
      'setup-failed',
      harness,
      ({ service, projectId, worktreeId }) => {
        harness.answerTrustWith(configuredHooks('exit 3'));
        harness.recordSetupRunAs(43);
        return service.runWorktreeSetup({ projectId, worktreeId });
      },
    );

    assert.equal(result.status, 'failed');
    assert.equal(result.status === 'failed' && result.runId, 43);
    assert.equal(result.status === 'failed' && result.failedHookType, 'command');
    // Commands launched into a half-prepared checkout are worse than no commands at all, so the
    // failing path deliberately stops here — the same rule `openWorktree` applies.
    assert.equal(harness.lifecycleRuns.length, 1);
  });
});
