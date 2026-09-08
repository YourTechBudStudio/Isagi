import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { gitMetadataOnPath, type LstatEntry } from './git-metadata.js';
import { removeTree } from './tests/fixtures.js';

/**
 * The ancestor walk in isolation. The injected `lstat` drives traversal and
 * errno handling together, which is what makes a second seam unnecessary: the
 * fake answers the same question the real call does, so it cannot drift into
 * testing a shape production never sees.
 *
 * These tests prove the helper. That the classifier maps each result to the
 * right rejection is proven in `project-root.failures.test.ts` and, for the two
 * reachable results, end to end in `project-root.classification.test.ts`.
 */

const NOT_FOUND = errno('ENOENT');

function errno(code: string) {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/** Present at exactly the listed paths; every other path is absent. */
function presentAt(paths: readonly string[], failures: Readonly<Record<string, string>> = {}) {
  const seen: string[] = [];
  const lstat: LstatEntry = (path) => {
    seen.push(path);
    const failureCode = failures[path];
    if (failureCode) {
      throw errno(failureCode);
    }
    if (!paths.includes(path)) {
      throw NOT_FOUND;
    }
  };
  return { lstat, seen };
}

const ROOT = parse(process.cwd()).root;

describe('marker detection', () => {
  test('a .git entry at the path is present, whatever it turns out to be', () => {
    const { lstat } = presentAt(['/a/b/.git']);
    assert.deepEqual(gitMetadataOnPath('/a/b', lstat), { kind: 'present', path: '/a/b/.git' });
  });

  test('a .git entry in an ancestor is present, and names the ancestor', () => {
    const { lstat } = presentAt(['/a/.git']);
    assert.deepEqual(gitMetadataOnPath('/a/b/c', lstat), { kind: 'present', path: '/a/.git' });
  });

  test('a directory with no Git metadata anywhere above it is absent', () => {
    const { lstat, seen } = presentAt([]);
    assert.deepEqual(gitMetadataOnPath('/a/b/c', lstat), { kind: 'absent' });
    // Terminates at the filesystem root by path arithmetic rather than a literal.
    assert.ok(seen.includes(join(ROOT, '.git')));
  });
});

describe('the bare-directory signature threshold', () => {
  test('two of the three signature entries are present', () => {
    const { lstat } = presentAt(['/a/b/HEAD', '/a/b/refs']);
    assert.deepEqual(gitMetadataOnPath('/a/b', lstat), { kind: 'present', path: '/a/b' });
  });

  test('all three are present', () => {
    const { lstat } = presentAt(['/a/b/HEAD', '/a/b/objects', '/a/b/refs']);
    assert.deepEqual(gitMetadataOnPath('/a/b', lstat), { kind: 'present', path: '/a/b' });
  });

  test('one alone is below the threshold and does not refuse an ordinary folder', () => {
    for (const entry of ['HEAD', 'objects', 'refs']) {
      const { lstat } = presentAt([`/a/b/${entry}`]);
      assert.deepEqual(
        gitMetadataOnPath('/a/b', lstat),
        { kind: 'absent' },
        `${entry} alone must not be enough`,
      );
    }
  });

  test('the signature is checked at every level, not only the candidate', () => {
    const { lstat } = presentAt(['/a/objects', '/a/refs']);
    assert.deepEqual(gitMetadataOnPath('/a/b/c', lstat), { kind: 'present', path: '/a' });
  });
});

describe('inspection failures are not absence', () => {
  for (const code of ['EACCES', 'EPERM', 'EIO']) {
    test(`${code} while probing a .git entry is indeterminate`, () => {
      const { lstat } = presentAt([], { '/a/b/.git': code });
      assert.deepEqual(gitMetadataOnPath('/a/b', lstat), {
        kind: 'indeterminate',
        path: '/a/b/.git',
      });
    });
  }

  test('a failure while probing the signature names the directory', () => {
    const { lstat } = presentAt([], { '/a/b/objects': 'EACCES' });
    assert.deepEqual(gitMetadataOnPath('/a/b', lstat), { kind: 'indeterminate', path: '/a/b' });
  });

  test('indeterminate wins over a below-threshold signature at the same level', () => {
    // Otherwise "we could not look" would be reported as "there is nothing there".
    const { lstat } = presentAt(['/a/b/HEAD'], { '/a/b/refs': 'EACCES' });
    assert.deepEqual(gitMetadataOnPath('/a/b', lstat), { kind: 'indeterminate', path: '/a/b' });
  });

  test('ENOENT and ENOTDIR are the only codes that mean absent', () => {
    for (const code of ['ENOENT', 'ENOTDIR']) {
      const { lstat } = presentAt([], { '/a/.git': code });
      assert.deepEqual(
        gitMetadataOnPath('/a', lstat),
        { kind: 'absent' },
        `${code} must mean the entry cannot exist`,
      );
    }
  });

  test('a thrown value carrying no code is indeterminate rather than absent', () => {
    const lstat: LstatEntry = () => {
      throw new Error('something unrecognized');
    };
    assert.equal(gitMetadataOnPath('/a/b', lstat).kind, 'indeterminate');
  });
});

describe('against a real filesystem', () => {
  let root: string;

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-git-metadata-')));
  });

  after(() => {
    removeTree(root);
  });

  test('a dangling .git symlink is present, which existsSync would miss', async () => {
    const { symlinkSync, existsSync } = await import('node:fs');
    const path = join(root, 'dangling');
    mkdirSync(path);
    symlinkSync(join(root, 'no-such-target'), join(path, '.git'));
    assert.equal(existsSync(join(path, '.git')), false, 'guard: existsSync follows the link');
    assert.deepEqual(gitMetadataOnPath(path, undefined), {
      kind: 'present',
      path: join(path, '.git'),
    });
  });

  test('a real EACCES from the default lstat is indeterminate', (t) => {
    const parent = join(root, 'unreadable');
    const candidate = join(parent, 'child');
    mkdirSync(candidate, { recursive: true });
    try {
      chmodSync(parent, 0o000);
      // Detect actual denial: the mode is ignored for root and on platforms
      // without POSIX permissions, and a uid check would not tell us that.
      let denied = false;
      try {
        lstatSync(join(candidate, '.git'));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        denied = code === 'EACCES' || code === 'EPERM';
      }
      if (!denied) {
        t.skip('permission denial could not be reproduced on this platform or as this user');
        return;
      }
      assert.equal(gitMetadataOnPath(candidate, undefined).kind, 'indeterminate');
    } finally {
      chmodSync(parent, 0o700);
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
