import assert from 'node:assert/strict';
import test from 'node:test';

import { Schema } from 'effect';

import {
  projectApiErrorSchema,
  projectRelocateApiErrorSchema,
  worktreeBranchListApiErrorSchema,
  worktreeDeleteApiErrorSchema,
  worktreeOpenApiErrorSchema,
  worktreeOrderApiErrorSchema,
  worktreeSetupApiErrorSchema,
} from '@isagi/contracts';
import type { ApiError } from '@isagi/contracts';

import { apiErrorDiagnostic, endpointDiagnostic, runtimeErrorCopy } from './errors.js';

function workflowRejected(data: Record<string, unknown>, requestId = 'req-1'): ApiError {
  return {
    code: 'workflow_rejected',
    status: 500,
    message: 'diagnostic message',
    requestId,
    data,
  } as ApiError;
}

test('workflow_discovery_failed maps to singular source-path copy', () => {
  assert.equal(
    runtimeErrorCopy.fromApiError(
      workflowRejected({
        reason: 'workflow_discovery_failed',
        workflowSourceDirectory: '/roots/x',
      }),
    ),
    "Couldn't read a workflow source path.",
  );
});

test('discovery diagnostic frames the failing source directory above code/request', () => {
  const detail = apiErrorDiagnostic(
    workflowRejected(
      { reason: 'workflow_discovery_failed', workflowSourceDirectory: '/roots/extra' },
      'req-disc',
    ),
  );
  assert.equal(detail, 'Source directory: /roots/extra\n\nworkflow_rejected · request req-disc');
});

test('load-failure diagnostic preserves winner then shadowed order', () => {
  const detail = apiErrorDiagnostic(
    workflowRejected(
      {
        reason: 'workflow_load_failed',
        workflowPackageDirectory: '/winner/release',
        shadowedWorkflowPackageDirectories: ['/lower/release', '/lowest/release'],
      },
      'req-load',
    ),
  );
  assert.equal(
    detail,
    [
      'Workflow package: /winner/release',
      'Shadowed package: /lower/release',
      'Shadowed package: /lowest/release',
      '',
      'workflow_rejected · request req-load',
    ].join('\n'),
  );
});

test('a workflow rejection without path fields degrades to code/request only', () => {
  assert.equal(
    apiErrorDiagnostic(workflowRejected({ reason: 'workflow_surface_busy' }, 'req-busy')),
    'workflow_rejected · request req-busy',
  );
});

test('a non-workflow API error yields only the code/request line', () => {
  const apiError = {
    code: 'runtime_database_failed',
    status: 500,
    message: 'db down',
    requestId: 'req-db',
    data: { operation: 'read' },
  } satisfies ApiError;
  assert.equal(apiErrorDiagnostic(apiError), 'runtime_database_failed · request req-db');
});

test('endpoint diagnostic frames the endpoint identifier', () => {
  assert.equal(endpointDiagnostic('workflows.descriptors'), 'Endpoint: workflows.descriptors');
});

/**
 * The reason literals story #38 adds to the versioned wire contract. Each one is
 * decoded through the error union its own endpoint actually declares, so a
 * literal added to a reason union but never reachable through that endpoint's
 * error schema fails here rather than at runtime as an encoding failure.
 *
 * The copy assertion rides along deliberately: proving the literal serializes is
 * only half of a wire change, and a reason that decodes but falls through to the
 * code's generic summary is a silently degraded message. Runtime cannot emit any
 * of these until the eligibility guard and the classifier land — this covers the
 * contract and the copy, not refusal behavior.
 */
interface RejectionCase {
  /** The union the owning endpoint actually declares for its errors. */
  readonly schema: Schema.Schema.AnyNoContext;
  readonly error: ApiError;
  readonly copy: string;
}

function pathRejected(reason: string): ApiError {
  return {
    code: 'project_path_rejected',
    status: 400,
    message: 'diagnostic message',
    requestId: 'req-kind',
    data: { reason, path: '/work/notes' },
  } as ApiError;
}

const folderNoWorktrees = 'This project is a plain folder, so it has no worktrees.';

const NEW_REJECTION_LITERALS: readonly RejectionCase[] = [
  {
    schema: projectApiErrorSchema,
    error: pathRejected('bare_repository'),
    copy: "That's a bare Git repository — there's no working tree to open.",
  },
  {
    schema: projectApiErrorSchema,
    error: pathRejected('git_unavailable'),
    copy: "Isagi couldn't run Git to check that folder.",
  },
  {
    schema: projectApiErrorSchema,
    error: pathRejected('git_metadata_unreadable'),
    copy: "There's Git data at or above that folder, but Git won't read it. Fix or remove it, then try again.",
  },
  {
    schema: projectApiErrorSchema,
    error: pathRejected('git_metadata_indeterminate'),
    copy: "Isagi couldn't inspect that folder or the ones above it, so it can't tell whether Git is involved.",
  },
  {
    schema: worktreeBranchListApiErrorSchema,
    error: {
      code: 'worktree_branch_list_rejected',
      status: 400,
      message: 'diagnostic message',
      requestId: 'req-kind',
      data: { reason: 'worktrees_not_supported', projectId: 1 },
    },
    copy: folderNoWorktrees,
  },
  {
    schema: worktreeOpenApiErrorSchema,
    error: {
      code: 'worktree_open_rejected',
      status: 400,
      message: 'diagnostic message',
      requestId: 'req-kind',
      data: { reason: 'worktrees_not_supported', projectId: 1 },
    },
    copy: folderNoWorktrees,
  },
  {
    schema: worktreeSetupApiErrorSchema,
    error: {
      code: 'worktree_setup_rejected',
      status: 400,
      message: 'diagnostic message',
      requestId: 'req-kind',
      data: { reason: 'worktrees_not_supported', projectId: 1 },
    },
    copy: folderNoWorktrees,
  },
  {
    schema: worktreeDeleteApiErrorSchema,
    error: {
      code: 'worktree_delete_rejected',
      status: 400,
      message: 'diagnostic message',
      requestId: 'req-kind',
      data: { reason: 'worktrees_not_supported', projectId: 1, worktreeId: 10 },
    },
    copy: folderNoWorktrees,
  },
  {
    schema: worktreeOrderApiErrorSchema,
    error: {
      code: 'worktree_order_rejected',
      status: 400,
      message: 'diagnostic message',
      requestId: 'req-kind',
      data: { reason: 'worktrees_not_supported', projectId: 1, worktreeId: 10 },
    },
    copy: folderNoWorktrees,
  },
  {
    schema: projectRelocateApiErrorSchema,
    error: {
      code: 'project_relocation_rejected',
      status: 400,
      message: 'diagnostic message',
      requestId: 'req-kind',
      data: { reason: 'relocation_not_supported', projectId: 1 },
    },
    copy: "Isagi can't move a folder project. Put the folder back, or remove it and add the new location.",
  },
];

test('every new folder-project rejection literal decodes through its endpoint error schema', () => {
  for (const entry of NEW_REJECTION_LITERALS) {
    const reason = (entry.error.data as { readonly reason: string }).reason;
    assert.doesNotThrow(
      () => Schema.decodeUnknownSync(entry.schema)(entry.error),
      `${entry.error.code}/${reason} should decode through its endpoint error schema`,
    );
  }
});

test('every new folder-project rejection literal has its own copy, not the generic summary', () => {
  for (const entry of NEW_REJECTION_LITERALS) {
    const reason = (entry.error.data as { readonly reason: string }).reason;
    assert.equal(
      runtimeErrorCopy.fromApiError(entry.error),
      entry.copy,
      `${entry.error.code}/${reason} should resolve to its own copy`,
    );
  }
});

test('the reworded inconclusive-probe copy no longer asserts the path is a repository', () => {
  assert.equal(
    runtimeErrorCopy.fromApiError(pathRejected('git_command_failed')),
    "Git couldn't tell Isagi what that folder is.",
  );
});
