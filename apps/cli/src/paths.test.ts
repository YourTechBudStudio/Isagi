import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { canonicalizeProspectivePath, isSameOrInside } from './paths.js';

test('a path that does not exist yet resolves through its nearest existing ancestor', () => {
  // On macOS `os.tmpdir()` sits behind the `/var` → `/private/var` symlink: the case the runtime's
  // rule handles the same way, so the path the CLI checks is the path the runtime returns.
  const root = mkdtempSync(join(tmpdir(), 'isagi-cli-paths-'));
  try {
    const real = realpathSync.native(root);
    assert.equal(canonicalizeProspectivePath(join(root, 'a', 'b')), join(real, 'a', 'b'));
    assert.equal(canonicalizeProspectivePath(root), real);

    mkdirSync(join(root, 'target'));
    symlinkSync(join(root, 'target'), join(root, 'link'));
    assert.equal(
      canonicalizeProspectivePath(join(root, 'link', 'new')),
      join(real, 'target', 'new'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('/tmp resolves to its real location on macOS', { skip: process.platform !== 'darwin' }, () => {
  assert.equal(
    canonicalizeProspectivePath('/tmp/isagi-never-created/x'),
    '/private/tmp/isagi-never-created/x',
  );
});

test('containment is at a separator boundary', () => {
  assert.ok(isSameOrInside('/a/repo', '/a/repo'));
  assert.ok(isSameOrInside('/a/repo/x', '/a/repo'));
  assert.ok(!isSameOrInside('/a/repo-other', '/a/repo'));
  assert.ok(isSameOrInside('/x', '/'));
});
