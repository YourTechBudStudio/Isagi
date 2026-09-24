import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { Effect, Exit } from 'effect';

import { normalizeWorktreeRelativePath, resolveWithinWorktree } from './paths.js';

const root = mkdtempSync(join(tmpdir(), 'isagi-evidence-paths-'));
after(() => rmSync(root, { recursive: true, force: true }));

const worktree = join(root, 'worktree');
mkdirSync(join(worktree, 'docs'), { recursive: true });
writeFileSync(join(worktree, 'docs', 'plan.md'), '# plan');

// A directory that a person deleting the worktree would not expect to be reachable from inside it.
const outside = join(root, 'outside');
mkdirSync(outside, { recursive: true });
writeFileSync(join(outside, 'secret.txt'), 'not yours');
symlinkSync(join(outside, 'secret.txt'), join(worktree, 'escape.txt'));
symlinkSync(outside, join(worktree, 'escape-dir'));

// A sibling whose name merely *starts* with the worktree's name. A prefix test without a separator
// would read this as living inside it.
const sibling = `${worktree}-other`;
mkdirSync(sibling, { recursive: true });
writeFileSync(join(sibling, 'plan.md'), 'elsewhere');
symlinkSync(join(sibling, 'plan.md'), join(worktree, 'sibling.md'));

const resolve = (relativePath: string) =>
  Effect.runPromiseExit(resolveWithinWorktree(worktree, relativePath));

const failureReason = async (relativePath: string) => {
  const exit = await resolve(relativePath);
  assert.equal(Exit.isFailure(exit), true, `expected ${relativePath} to fail`);
  return Exit.isFailure(exit)
    ? ((exit.cause as { error?: { reason?: string } }).error?.reason ?? 'unknown')
    : 'unknown';
};

describe('worktree-relative path normalisation', () => {
  it('reduces a legal path to the one spelling that enters the identity', () => {
    assert.deepEqual(normalizeWorktreeRelativePath('docs/plan.md'), {
      ok: true,
      path: 'docs/plan.md',
    });
    assert.deepEqual(normalizeWorktreeRelativePath('./docs/plan.md'), {
      ok: true,
      path: 'docs/plan.md',
    });
    assert.deepEqual(normalizeWorktreeRelativePath('docs\\plan.md'), {
      ok: true,
      path: 'docs/plan.md',
    });
    assert.deepEqual(normalizeWorktreeRelativePath('docs/../plan.md'), {
      ok: true,
      path: 'plan.md',
    });
  });

  it('refuses anything that is not relative, or that normalises out of the tree', () => {
    // `C:\x` and `/abs` are platform-independent refusals here on purpose: what an author may name
    // must not change with the machine the runtime happens to be running on.
    for (const candidate of [
      '/abs/x',
      '\\abs\\x',
      'C:\\x',
      'c:/x',
      '../x',
      'a/../../x',
      '',
      '.',
      './',
      'a\0b',
    ]) {
      assert.deepEqual(
        normalizeWorktreeRelativePath(candidate),
        { ok: false, reason: 'path_outside_worktree' },
        `expected ${JSON.stringify(candidate)} to be refused`,
      );
    }
  });
});

describe('resolving a path inside the worktree', () => {
  it('resolves a real file to its realpath, not to the spelling it was asked about', async () => {
    const exit = await resolve('docs/plan.md');
    // Deliberately compared against the *resolved* root: on macOS a temp directory lives under a
    // `/var` -> `/private/var` symlink, so the resolved answer legitimately differs from the joined
    // one. That is the whole reason containment is checked realpath-to-realpath.
    assert.deepEqual(
      exit,
      Exit.succeed({ absolute: join(realpathSync(worktree), 'docs', 'plan.md') }),
    );
  });

  it('refuses a symlink that leaves the worktree, which no `..` check would catch', async () => {
    assert.equal(await failureReason('escape.txt'), 'path_outside_worktree');
    assert.equal(await failureReason('escape-dir/secret.txt'), 'path_outside_worktree');
  });

  it('refuses a sibling directory whose name merely starts with the worktree path', async () => {
    assert.equal(await failureReason('sibling.md'), 'path_outside_worktree');
  });

  it('distinguishes a missing path from a path that is not a regular file', async () => {
    assert.equal(await failureReason('docs/absent.md'), 'path_not_found');
    assert.equal(await failureReason('docs'), 'not_a_file');
  });
});
