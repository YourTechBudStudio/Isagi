import assert from 'node:assert/strict';
import test from 'node:test';

import { Schema } from 'effect';

import {
  listWorkflowCheckpointsQuerySchema,
  workflowCheckpointBaseSchema,
  workflowCheckpointInventoryEntrySchema,
  workflowCheckpointRegionWarningReasonSchema,
  workflowCheckpointWarningReasonSchema,
} from './checkpoints.js';

const decodes = <A, I>(schema: Schema.Schema<A, I>, value: unknown) =>
  Schema.decodeUnknownEither(schema)(value)._tag === 'Right';

test('a git base names an exact SHA-1 or SHA-256 commit and a none base names why', () => {
  const sha1 = 'a'.repeat(40);
  const sha256 = 'b'.repeat(64);
  assert.ok(
    decodes(workflowCheckpointBaseSchema, { kind: 'git', repositoryId: 1, commitSha: sha1 }),
  );
  assert.ok(
    decodes(workflowCheckpointBaseSchema, { kind: 'git', repositoryId: 1, commitSha: sha256 }),
  );
  assert.ok(
    !decodes(workflowCheckpointBaseSchema, { kind: 'git', repositoryId: 1, commitSha: 'HEAD' }),
  );
  assert.ok(
    !decodes(workflowCheckpointBaseSchema, {
      kind: 'git',
      repositoryId: 1,
      commitSha: 'a'.repeat(41),
    }),
  );
  assert.ok(decodes(workflowCheckpointBaseSchema, { kind: 'none', reason: 'folder_project' }));
  assert.ok(decodes(workflowCheckpointBaseSchema, { kind: 'none', reason: 'unborn_repository' }));
  assert.ok(!decodes(workflowCheckpointBaseSchema, { kind: 'none', reason: 'deleted' }));
});

test('descendants is refused without the execution it descends from', () => {
  assert.ok(decodes(listWorkflowCheckpointsQuerySchema, { executionId: 3, descendants: 'true' }));
  assert.ok(decodes(listWorkflowCheckpointsQuerySchema, { descendants: 'false' }));
  assert.ok(!decodes(listWorkflowCheckpointsQuerySchema, { descendants: 'true' }));
  assert.ok(!decodes(listWorkflowCheckpointsQuerySchema, { limit: 501 }));
});

test('region warning reasons are a subset of the warning vocabulary', () => {
  const all = new Set<string>(workflowCheckpointWarningReasonSchema.literals);
  for (const reason of workflowCheckpointRegionWarningReasonSchema.literals) {
    assert.ok(all.has(reason), reason);
  }
});

test('a file entry carries a bare sha256 digest, never a content reference', () => {
  const file = { kind: 'file', path: 'a.md', fileId: 'wcf_1', sizeBytes: 3, executable: false };
  assert.ok(decodes(workflowCheckpointInventoryEntrySchema, { ...file, sha256: 'c'.repeat(64) }));
  assert.ok(
    !decodes(workflowCheckpointInventoryEntrySchema, {
      ...file,
      sha256: `sha256:${'c'.repeat(64)}`,
    }),
  );
});
