import assert from 'node:assert/strict';
import test from 'node:test';

import { Schema } from 'effect';

import { worktreeOpenRejectedErrorSchema } from '../api/errors.js';
import { openWorktreeInputSchema, worktreeBaseRefSchema } from './types.js';

/**
 * The worktree open input is a trust boundary: a caller supplies it, and a value that decodes is a
 * value the workspace service will act on. These cases pin the two members this contract gained for
 * workflow-chosen environments — an already-resolved commit base, and the refusal mode — because a
 * malformed one must be rejected here rather than reaching Git.
 */

const decode = <A, I>(schema: Schema.Schema<A, I>, value: unknown): A =>
  Schema.decodeUnknownSync(schema)(value as I);

const commit = 'a'.repeat(40);

test('a base ref can name an already-resolved commit, beside a branch and a detached worktree', () => {
  assert.deepEqual(decode(worktreeBaseRefSchema, { kind: 'commit', commit }), {
    kind: 'commit',
    commit,
  });
  // The two existing members are unchanged by the addition.
  assert.deepEqual(decode(worktreeBaseRefSchema, { kind: 'branch', ref: 'main' }), {
    kind: 'branch',
    ref: 'main',
  });
  assert.deepEqual(decode(worktreeBaseRefSchema, { kind: 'detached_worktree', worktreeId: 3 }), {
    kind: 'detached_worktree',
    worktreeId: 3,
  });
});

test('a commit base must be a full 40-hex object name, not a prefix or a ref', () => {
  // The point of the pattern: an abbreviated or symbolic value would resolve differently later, or
  // resolve to something else entirely, and the caller has already claimed it resolved this.
  for (const invalid of [
    'a'.repeat(39),
    'a'.repeat(41),
    'A'.repeat(40),
    `${'a'.repeat(39)}z`,
    'main',
    '',
  ]) {
    assert.throws(
      () => decode(worktreeBaseRefSchema, { kind: 'commit', commit: invalid }),
      `"${invalid}" should not decode as a commit base`,
    );
  }
  // A commit base that names the wrong identity for its kind is not a near-miss it can fall into.
  assert.throws(() => decode(worktreeBaseRefSchema, { kind: 'commit', ref: 'main' }));
});

test('open mode is optional, and only the two declared modes decode', () => {
  const branch = 'feat/x';
  // Omitted stays legal: `open` is the default, and today's UI caller sends no mode at all.
  assert.equal(decode(openWorktreeInputSchema, { branch }).mode, undefined);
  assert.equal(decode(openWorktreeInputSchema, { branch, mode: 'open' }).mode, 'open');
  assert.equal(decode(openWorktreeInputSchema, { branch, mode: 'create_new' }).mode, 'create_new');
  // An unrecognised mode must not silently degrade to the adopting default: that would turn a
  // caller's "refuse a collision" into "reuse whatever is there".
  for (const mode of ['create', 'new', 'CREATE_NEW', '']) {
    assert.throws(() => decode(openWorktreeInputSchema, { branch, mode }), `mode "${mode}"`);
  }
});

test('a create_new refusal names what already exists, and which one', () => {
  // `create_new` is the only way these two reasons can be raised, so they arrive with the identity
  // a person needs to act: the branch that exists, or the worktree already holding it.
  const branchTaken = decode(worktreeOpenRejectedErrorSchema, {
    code: 'worktree_open_rejected',
    status: 409,
    message: 'that branch already exists',
    requestId: 'req-1',
    data: { reason: 'branch_exists', projectId: 2, branch: 'feat/x' },
  });
  assert.equal(branchTaken.data.reason, 'branch_exists');
  assert.equal(branchTaken.data.branch, 'feat/x');

  const worktreeTaken = decode(worktreeOpenRejectedErrorSchema, {
    code: 'worktree_open_rejected',
    status: 409,
    message: 'that branch is already checked out',
    requestId: 'req-1',
    data: {
      reason: 'worktree_exists',
      projectId: 2,
      branch: 'feat/x',
      worktreeId: 4,
      path: '/w/feat-x',
    },
  });
  assert.equal(worktreeTaken.data.worktreeId, 4);
  assert.equal(worktreeTaken.data.path, '/w/feat-x');

  assert.throws(() =>
    decode(worktreeOpenRejectedErrorSchema, {
      code: 'worktree_open_rejected',
      status: 409,
      message: 'something already exists',
      requestId: 'req-1',
      data: { reason: 'already_there' },
    }),
  );
});
