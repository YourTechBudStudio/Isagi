import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Layer, Schema } from 'effect';
import type { FastifyInstance } from 'fastify';

import { apiEndpoints } from '@isagi/contracts';

import { CommandService, type CommandServiceShape } from '../../commands/index.js';
import { Git, type GitService } from '../../git/index.js';
import { DataDirectory, StateFile } from '../../persistence/index.js';
import { PtyService, type PtyServiceShape } from '../../pty-processes/index.js';
import { InternalRuntimeEventBus } from '../../runtime-events/index.js';
import { SurfaceRepository } from '../../surfaces/index.js';
import {
  WorktreeSetupRepository,
  WorktreeSetupService,
  type WorktreeSetupRepositoryService,
  type WorktreeSetupService as WorktreeSetupServiceShape,
} from '../../worktree-setup/index.js';
import type { ProjectRow } from '../types.js';
import { WorkspaceRepository, type WorkspaceRepositoryService } from '../workspace.repository.js';
import { WorkspaceServiceLive } from '../workspace.service.js';
import { withWorkspaceApi } from './api-test-support.js';
import { runWithDatabase } from './repository-test-support.js';
import {
  project,
  stateFileWithWriteCounter,
  testDataDirectory,
  testInternalEvents,
  testSurfaceRepository,
  worktree,
} from './test-support.js';

/**
 * Every dependency a refused management request must not touch dies rather than
 * returning a value. A guard that fails to fire therefore surfaces as a named
 * defect instead of a passing `equal(callCount, 0)` — and the assertion cannot
 * rot, because it is the double itself.
 *
 * `moveProjectWorktreeOrder` is the deliberate exception and is not modelled
 * here: reorder eligibility lives inside the repository transaction, so the
 * service is *supposed* to call it. That route uses the real repository and
 * unchanged-state assertions instead (`repository.reorder.test.ts`, and the
 * wire case at the end of this file).
 */
const forbiddenGit = {
  run: (args: readonly string[]) =>
    Effect.die(new Error(`git must not run for an unsupported request: git ${args.join(' ')}`)),
} satisfies GitService;

const forbiddenWorktreeSetup = {
  preflight: () => Effect.die(new Error('worktree setup preflight must not read hook config')),
  updateTrust: () => Effect.die(new Error('worktree setup must not write trust')),
  validateTrustForOpen: () => Effect.die(new Error('worktree setup must not validate trust')),
} satisfies WorktreeSetupServiceShape;

const forbiddenWorktreeSetupRepository = {
  findTrust: () => Effect.die(new Error('trust must not be read')),
  setTrustedHash: () => Effect.die(new Error('trust must not be written')),
  disableHooks: () => Effect.die(new Error('hooks must not be disabled')),
  createRunWithSteps: () => Effect.die(new Error('setup runs must not be recorded')),
  listRunSteps: () => Effect.die(new Error('setup run steps must not be read')),
} satisfies WorktreeSetupRepositoryService;

const forbiddenCommands = {
  listForWorktree: () => Effect.die(new Error('commands must not be listed')),
  readLogMetadata: () => Effect.die(new Error('command logs must not be read')),
  run: () => Effect.die(new Error('commands must not run')),
  stop: () => Effect.die(new Error('commands must not stop')),
  restart: () => Effect.die(new Error('commands must not restart')),
  runPostCreateLifecycle: () => Effect.die(new Error('postCreate must not run')),
  cleanupBeforeWorktreeDelete: () => Effect.die(new Error('command cleanup must not run')),
  cleanupBeforeWorktreePrune: () => Effect.die(new Error('prune cleanup must not run')),
} satisfies CommandServiceShape;

const forbiddenPty = {
  allocateLaunch: () => Effect.die(new Error('pty must not be allocated')),
  readLogTail: () => Effect.die(new Error('pty logs must not be read')),
  launch: () => Effect.die(new Error('pty must not launch')),
  getAttachmentPlan: () => Effect.die(new Error('pty must not plan attachment')),
  attach: () => Effect.die(new Error('pty must not attach')),
  replay: () => Effect.die(new Error('pty must not replay')),
  write: () => Effect.die(new Error('pty must not be written to')),
  writeInput: () => Effect.die(new Error('pty must not receive input')),
  resize: () => Effect.die(new Error('pty must not resize')),
  kill: () => Effect.die(new Error('pty must not be killed')),
  terminate: () => Effect.die(new Error('pty must not be terminated')),
  cleanupProcess: () => Effect.die(new Error('pty must not be cleaned up')),
  pin: () => Effect.die(new Error('pty must not be pinned')),
  unpin: () => Effect.die(new Error('pty must not be unpinned')),
  isPinned: () => Effect.die(new Error('pty pinning must not be read')),
} satisfies PtyServiceShape;

/**
 * Resolves the project row under test and dies on everything a refused request
 * must not reach — including the reads that would follow the guard, so the
 * matrix also establishes that kind precedes worktree lookup.
 */
function forbiddenRepositoryFor(row: ProjectRow): WorkspaceRepositoryService {
  return {
    findProject: (projectId) => Effect.succeed(projectId === row.id ? row : null),
    listProjects: Effect.succeed([row]),
    listDurableSessions: Effect.die(new Error('durable sessions must not be read')),
    findProjectByRootPath: () => Effect.die(new Error('root path lookup must not run')),
    findWorktree: () => Effect.die(new Error('worktree lookup must not run')),
    findProjectWorktree: () => Effect.die(new Error('project worktree lookup must not run')),
    findProjectRootWorktree: () => Effect.die(new Error('root worktree lookup must not run')),
    findProjectWorktreeByBranch: () => Effect.die(new Error('branch lookup must not run')),
    deleteProject: () => Effect.die(new Error('project must not be deleted')),
    deleteWorktree: () => Effect.die(new Error('worktree rows must not be deleted')),
    readWorktreeDeleteDiagnostics: () => Effect.die(new Error('delete diagnostics must not run')),
    createProject: () => Effect.die(new Error('projects must not be created')),
    listWorktrees: Effect.die(new Error('worktrees must not be listed')),
    reconcileProjectWorktrees: () => Effect.die(new Error('reconciliation must not run')),
    restoreProjectAtRootPath: () => Effect.die(new Error('restoration must not run')),
    setProjectStatus: () => Effect.die(new Error('project status must not be written')),
    moveProjectOrder: () => Effect.die(new Error('project order must not move')),
    moveProjectWorktreeOrder: () => Effect.die(new Error('worktree order must not move')),
  };
}

function workspaceLayerWith(repository: WorkspaceRepositoryService) {
  return WorkspaceServiceLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(WorkspaceRepository, repository),
        Layer.succeed(CommandService, forbiddenCommands),
        Layer.succeed(PtyService, forbiddenPty),
        Layer.succeed(InternalRuntimeEventBus, testInternalEvents),
        Layer.succeed(SurfaceRepository, testSurfaceRepository),
        Layer.succeed(
          StateFile,
          stateFileWithWriteCounter(() => {}),
        ),
        Layer.succeed(Git, forbiddenGit),
        Layer.succeed(DataDirectory, testDataDirectory),
        Layer.succeed(WorktreeSetupService, forbiddenWorktreeSetup),
        Layer.succeed(WorktreeSetupRepository, forbiddenWorktreeSetupRepository),
      ),
    ),
  );
}

interface ManagementRequest {
  readonly label: string;
  readonly endpoint: { readonly errors: Schema.Schema.AnyNoContext };
  readonly method: 'DELETE' | 'GET' | 'POST' | 'PUT';
  readonly url: string;
  readonly payload?: Record<string, unknown>;
  readonly code: string;
}

/**
 * One entry per guarded operation, with a request that decodes cleanly: an
 * invalid body would be refused during decoding and never reach the guard, so
 * `disable_hooks`, a real branch name and a force deletion are all deliberate.
 */
const managementRequests: readonly ManagementRequest[] = [
  {
    label: 'worktrees.branches',
    endpoint: apiEndpoints.worktrees.branches,
    method: 'GET',
    url: '/api/v1/projects/1/branches',
    code: 'worktree_branch_list_rejected',
  },
  {
    label: 'worktrees.setupPreflight',
    endpoint: apiEndpoints.worktrees.setupPreflight,
    method: 'POST',
    url: '/api/v1/projects/1/worktrees/setup/preflight',
    code: 'worktree_setup_rejected',
  },
  {
    label: 'worktrees.setupTrust',
    endpoint: apiEndpoints.worktrees.setupTrust,
    method: 'PUT',
    url: '/api/v1/projects/1/worktrees/setup/trust',
    payload: { action: 'disable_hooks' },
    code: 'worktree_setup_rejected',
  },
  {
    label: 'worktrees.open',
    endpoint: apiEndpoints.worktrees.open,
    method: 'POST',
    url: '/api/v1/projects/1/worktrees/open',
    payload: { branch: 'feature/eligibility' },
    code: 'worktree_open_rejected',
  },
  {
    label: 'worktrees.deletePreflight',
    endpoint: apiEndpoints.worktrees.deletePreflight,
    method: 'POST',
    url: '/api/v1/projects/1/worktrees/10/delete/preflight',
    code: 'worktree_delete_rejected',
  },
  {
    label: 'worktrees.delete',
    endpoint: apiEndpoints.worktrees.delete,
    method: 'DELETE',
    url: '/api/v1/projects/1/worktrees/10',
    payload: { checkoutRemovalMode: 'force', branchRemovalMode: 'delete_if_safe' },
    code: 'worktree_delete_rejected',
  },
];

/** Targets that do not exist, to establish that kind precedes worktree lookup. */
const nonexistentTargetRequests: readonly ManagementRequest[] = [
  {
    label: 'worktrees.deletePreflight',
    endpoint: apiEndpoints.worktrees.deletePreflight,
    method: 'POST',
    url: '/api/v1/projects/1/worktrees/999/delete/preflight',
    code: 'worktree_delete_rejected',
  },
  {
    label: 'worktrees.delete',
    endpoint: apiEndpoints.worktrees.delete,
    method: 'DELETE',
    url: '/api/v1/projects/1/worktrees/999',
    payload: { checkoutRemovalMode: 'force', branchRemovalMode: 'delete_if_safe' },
    code: 'worktree_delete_rejected',
  },
];

const relocateRequest = {
  endpoint: apiEndpoints.projects.relocate,
  method: 'POST' as const,
  url: '/api/v1/projects/1/relocate',
  payload: { path: '/repo/isagi-moved' },
  code: 'project_relocation_rejected',
};

const presentFolderProject: ProjectRow = { ...project, kind: 'folder' };

const missingFolderProject: ProjectRow = {
  ...presentFolderProject,
  status: 'missing',
  missingReason: 'missing',
};

/**
 * Recorded present, but its directory is gone. The interesting property is that
 * the guard sits ahead of `ensureProjectPathAvailable`, which is what would
 * durably demote the row — so the refusal must arrive with the project still
 * present. `setProjectStatus` dies, so a demotion could not pass quietly.
 */
function vanishedFolderProject(): ProjectRow {
  return {
    ...presentFolderProject,
    rootPath: join(tmpdir(), 'isagi-folder-eligibility-vanished'),
  };
}

async function requestRejection(
  row: ProjectRow,
  request: Pick<ManagementRequest, 'endpoint' | 'method' | 'payload' | 'url'>,
) {
  return withWorkspaceApi(
    workspaceLayerWith(forbiddenRepositoryFor(row)),
    async (fastify: FastifyInstance) => {
      const response = await fastify.inject(
        request.payload === undefined
          ? { method: request.method, url: request.url }
          : { method: request.method, url: request.url, payload: request.payload },
      );
      const body = response.json() as {
        readonly error?: {
          readonly code?: string;
          readonly message?: string;
          readonly status?: number;
          readonly data?: unknown;
          readonly requestId?: unknown;
        };
      };
      // A forbidden double died: surface its message instead of letting the
      // caller report only `500 !== 400`, which says nothing about what leaked.
      if (response.statusCode >= 500) {
        assert.fail(
          `${request.method} ${request.url} reached work it must not: ${JSON.stringify(body.error)}`,
        );
      }
      return { body, response };
    },
  );
}

for (const request of managementRequests) {
  test(`${request.label} refuses a folder project with its own family reason`, async () => {
    const { body, response } = await requestRejection(presentFolderProject, request);

    assert.equal(response.statusCode, 400);
    assert.equal(body.error?.code, request.code);
    assert.deepEqual(body.error?.data, {
      reason: 'worktrees_not_supported',
      projectId: presentFolderProject.id,
    });
    // The envelope is what the endpoint declares it can return. `sendRouteApiError`
    // already refuses to send an error its schema rejects, so this decoding is a
    // direct assertion of the same contract rather than a restatement.
    assert.doesNotThrow(() => Schema.decodeUnknownSync(request.endpoint.errors)(body.error));
  });
}

for (const request of nonexistentTargetRequests) {
  test(`${request.label} reports unsupported kind ahead of a nonexistent worktree target`, async () => {
    const { body, response } = await requestRejection(presentFolderProject, request);

    assert.equal(response.statusCode, 400);
    assert.equal(body.error?.code, request.code);
    assert.deepEqual(body.error?.data, {
      reason: 'worktrees_not_supported',
      projectId: presentFolderProject.id,
    });
  });
}

for (const request of managementRequests) {
  test(`${request.label} refuses a folder project whose directory disappeared without demoting it`, async () => {
    const { body, response } = await requestRejection(vanishedFolderProject(), request);

    assert.equal(response.statusCode, 400);
    assert.equal(body.error?.code, request.code);
    assert.deepEqual(body.error?.data, {
      reason: 'worktrees_not_supported',
      projectId: presentFolderProject.id,
    });
  });
}

for (const request of managementRequests) {
  test(`${request.label} reports the existing presence rejection for a missing folder project`, async () => {
    const { body, response } = await requestRejection(missingFolderProject, request);

    assert.equal(response.statusCode, 400);
    assert.equal(body.error?.code, request.code);
    assert.deepEqual(body.error?.data, {
      reason: 'project_not_present',
      projectId: presentFolderProject.id,
    });
  });
}

for (const [label, row] of [
  ['present', presentFolderProject],
  ['missing', missingFolderProject],
] as const) {
  test(`projects.relocate refuses a ${label} folder project as unsupported`, async () => {
    const { body, response } = await requestRejection(row, relocateRequest);

    assert.equal(response.statusCode, 400);
    assert.equal(body.error?.code, relocateRequest.code);
    assert.deepEqual(body.error?.data, {
      reason: 'relocation_not_supported',
      projectId: presentFolderProject.id,
    });
    assert.doesNotThrow(() =>
      Schema.decodeUnknownSync(relocateRequest.endpoint.errors)(body.error),
    );
  });
}

test('a Git project still reaches the work the guard refuses for folders', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'isagi-eligibility-git-'));
  const gitProject: ProjectRow = { ...project, rootPath: projectRoot };
  let branchListCalls = 0;
  const repository: WorkspaceRepositoryService = {
    ...forbiddenRepositoryFor(gitProject),
    listWorktrees: Effect.succeed([{ ...worktree, path: projectRoot }]),
  };
  const layer = WorkspaceServiceLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(WorkspaceRepository, repository),
        Layer.succeed(CommandService, forbiddenCommands),
        Layer.succeed(PtyService, forbiddenPty),
        Layer.succeed(InternalRuntimeEventBus, testInternalEvents),
        Layer.succeed(SurfaceRepository, testSurfaceRepository),
        Layer.succeed(
          StateFile,
          stateFileWithWriteCounter(() => {}),
        ),
        Layer.succeed(DataDirectory, testDataDirectory),
        Layer.succeed(WorktreeSetupService, forbiddenWorktreeSetup),
        Layer.succeed(WorktreeSetupRepository, forbiddenWorktreeSetupRepository),
        Layer.succeed(Git, {
          run: () =>
            Effect.sync(() => {
              branchListCalls += 1;
              return { stdout: 'main\n', stderr: '' };
            }),
        } satisfies GitService),
      ),
    ),
  );

  try {
    await withWorkspaceApi(layer, async (fastify) => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/api/v1/projects/1/branches',
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json().data, {
        branches: [{ name: 'main', worktreeId: worktree.id }],
      });
    });
    assert.equal(branchListCalls, 1);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('a project the workspace does not know still reports project_not_found', async () => {
  const { body, response } = await requestRejection(
    { ...presentFolderProject, id: 2 },
    managementRequests[0] as ManagementRequest,
  );

  assert.equal(response.statusCode, 400);
  assert.equal(body.error?.code, 'worktree_branch_list_rejected');
  assert.deepEqual(body.error?.data, { reason: 'project_not_found', projectId: 1 });
});

/**
 * The one reorder case that goes over the wire. The other six management guards
 * live in the service, so a repository double proves them; reorder's guard lives
 * inside the repository transaction, where a double returning the expected
 * rejection would prove only that the service translates what it is handed. So
 * this drives the real repository, the real service and the real route, and
 * `repository.reorder.test.ts` owns the remaining rejection variants.
 */
test('worktrees.moveOrder carries the real repository refusal to the wire', async () => {
  await runWithDatabase(
    'eligibility-reorder-wire',
    Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const { id: projectId } = yield* repository.createProject({
        name: 'notes',
        rootPath: '/repo/notes',
        kind: 'folder',
      });
      const environment = (yield* repository.listWorktrees).find(
        (row) => row.projectId === projectId,
      );
      assert.ok(environment);
      const before = yield* repository.listWorktrees;

      // Awaited inside the effect: the inner runtime borrows this repository, so
      // it must be disposed before the outer scope closes its database.
      yield* Effect.promise(() =>
        withWorkspaceApi(workspaceLayerWith(repository), async (fastify) => {
          const response = await fastify.inject({
            method: 'PUT',
            url: `/api/v1/projects/${projectId}/worktrees/${environment.id}/order`,
            payload: { beforeWorktreeId: null },
          });
          const body = response.json() as {
            readonly error?: { readonly code?: string; readonly data?: unknown };
          };

          assert.equal(response.statusCode, 400);
          assert.equal(body.error?.code, 'worktree_order_rejected');
          assert.deepEqual(body.error?.data, {
            reason: 'worktrees_not_supported',
            projectId,
            worktreeId: environment.id,
          });
          assert.doesNotThrow(() =>
            Schema.decodeUnknownSync(apiEndpoints.worktrees.moveOrder.errors)(body.error),
          );
        }),
      );

      assert.deepEqual(yield* repository.listWorktrees, before);
    }),
  );
});
