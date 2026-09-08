import assert from 'node:assert/strict';
import test from 'node:test';

import { branchLabel, worktreeSubtitle } from './selectors.js';
import type { Worktree } from './types.js';

/**
 * The rail's second line and the status strip's tag are the two places a Git ref
 * could reach the screen. After this phase only the second one formats refs at
 * all, and it refuses to do so without being told the project's kind.
 */

test('a worktree subtitle is the path alone, for both project kinds', () => {
  // A folder environment has no ref at all: the old fallback printed the literal
  // word `detached` here, which was false rather than merely unhelpful.
  assert.equal(worktreeSubtitle(worktree({ branch: null, head: null })), '/repo/notes');

  // A branched Git worktree: the ref is gone from here too. `worktreeTitle` in
  // the runtime returns the branch, so the row already prints it as its title.
  assert.equal(worktreeSubtitle(worktree({ branch: 'feat/folders' })), '/repo/notes');

  // A branchless Git worktree, likewise. Its commit is named in the status strip.
  assert.equal(worktreeSubtitle(worktree({ branch: null, head: '9f2c1abcdef' })), '/repo/notes');
});

test('a folder environment is given no branch label to render', () => {
  assert.equal(branchLabel(worktree({ branch: null, head: null }), 'folder'), null);
  // Even if a folder row somehow carried Git facts, its kind still decides.
  assert.equal(branchLabel(worktree({ branch: 'main', head: 'abc1234' }), 'folder'), null);
});

test('a Git environment still names its branch, its short head, or detached', () => {
  assert.equal(branchLabel(worktree({ branch: 'feat/folders' }), 'git'), 'feat/folders');
  assert.equal(branchLabel(worktree({ branch: null, head: '9f2c1abcdef' }), 'git'), '9f2c1ab');
  // A genuinely detached Git worktree with no head to shorten: the one place the
  // word survives, and the distinction the whole change turns on.
  assert.equal(branchLabel(worktree({ branch: null, head: null }), 'git'), 'detached');
});

function worktree(input: {
  readonly branch?: string | null;
  readonly head?: string | null;
}): Worktree {
  return {
    id: 1,
    projectId: 1,
    title: 'folder',
    path: '/repo/notes',
    branch: input.branch ?? null,
    head: input.head ?? null,
    isRoot: true,
    attention: 'idle',
    parked: false,
    surfaces: [],
    activeSurfaceId: null,
  };
}
