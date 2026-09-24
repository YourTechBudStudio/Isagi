import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { Effect, Either } from 'effect';

import {
  classifyEntrySpelling,
  makeDirectorySnapshot,
  nodeDirectoryReader,
  resolveAlias,
  resolveScopeRoot,
  type DirectoryReader,
  type EntryStat,
} from './paths.js';

/**
 * Checkpoint path identity, exercised through a fake `DirectoryReader` so case-sensitive and
 * case-insensitive destinations are both covered on any host.
 *
 * The fake folds with `toLowerCase` only to *simulate* an insensitive filesystem's lookup; the code
 * under test never folds, it only compares `lstat` success with the directory listing.
 */

type FakeNode =
  | { readonly type: 'dir'; readonly ino: number; readonly children: Map<string, FakeNode> }
  | { readonly type: 'file' | 'symlink' | 'fifo'; readonly ino: number };

class FakeFs implements DirectoryReader {
  private nextIno = 1;
  readonly root: FakeNode & { type: 'dir' } = this.dir();
  readonly failures = new Map<string, string>();
  readonly counts = { readdir: 0 };

  readonly insensitive: boolean;

  constructor(insensitive: boolean) {
    this.insensitive = insensitive;
  }

  dir(): FakeNode & { type: 'dir' } {
    return { type: 'dir', ino: this.nextIno++, children: new Map() };
  }

  node(type: 'file' | 'symlink' | 'fifo'): FakeNode {
    return { type, ino: this.nextIno++ };
  }

  /** Create `relative` as `type`, making directories along the way. */
  put(relative: string, type: 'dir' | 'file' | 'symlink' | 'fifo', existing?: FakeNode): FakeNode {
    const names = relative.split('/');
    let current = this.root;
    for (const name of names.slice(0, -1)) {
      const next = current.children.get(name) ?? this.dir();
      current.children.set(name, next);
      assert.equal(next.type, 'dir');
      current = next as FakeNode & { type: 'dir' };
    }
    const created = existing ?? (type === 'dir' ? this.dir() : this.node(type));
    current.children.set(names.at(-1)!, created);
    return created;
  }

  remove(relative: string): void {
    const names = relative.split('/');
    const parent = this.find(names.slice(0, -1));
    assert.ok(parent && parent.type === 'dir');
    parent.children.delete(names.at(-1)!);
  }

  private lookup(children: Map<string, FakeNode>, name: string): FakeNode | undefined {
    const exact = children.get(name);
    if (exact || !this.insensitive) return exact;
    for (const [candidate, node] of children) {
      if (candidate.toLowerCase() === name.toLowerCase()) return node;
    }
    return undefined;
  }

  private find(names: readonly string[]): FakeNode | undefined {
    let current: FakeNode = this.root;
    for (const name of names) {
      if (current.type !== 'dir') throw Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' });
      const next = this.lookup(current.children, name);
      if (!next) return undefined;
      current = next;
    }
    return current;
  }

  private resolve(absolute: string): FakeNode {
    const failure = this.failures.get(absolute);
    if (failure) throw Object.assign(new Error(failure), { code: failure });
    const relative = absolute === '/wt' ? '' : absolute.slice('/wt/'.length);
    const node = this.find(relative === '' ? [] : relative.split('/'));
    if (!node) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return node;
  }

  readdir = async (absolute: string) => {
    this.counts.readdir += 1;
    const node = this.resolve(absolute);
    if (node.type !== 'dir') throw Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' });
    return [...node.children.keys()];
  };

  lstat = async (absolute: string): Promise<EntryStat> => {
    const node = this.resolve(absolute);
    const kind = node.type === 'dir' ? 'directory' : node.type === 'fifo' ? 'other' : node.type;
    return { kind, dev: 1, ino: node.ino, size: 0, mtimeMs: 0, mode: 0o644 };
  };

  realpath = async (absolute: string) => absolute;
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.either(effect));

async function scopeRoot(
  fs: FakeFs,
  path: string,
  kind: 'directory' | 'file' = 'directory',
  exclusions: readonly string[] = [],
) {
  return run(resolveScopeRoot(makeDirectorySnapshot(fs), '/wt', path, kind, exclusions));
}

function failureOf<A, E extends { reason: string; path: string }>(result: Either.Either<A, E>) {
  assert.ok(Either.isLeft(result), 'expected a failure');
  return { reason: result.left.reason, path: result.left.path };
}

for (const insensitive of [false, true]) {
  const label = insensitive ? 'case-insensitive' : 'case-sensitive';

  describe(`scope root resolution on a ${label} filesystem`, () => {
    it('resolves a verbatim directory and file root', async () => {
      const fs = new FakeFs(insensitive);
      fs.put('apps/web/index.ts', 'file');
      assert.deepEqual(
        await scopeRoot(fs, 'apps/web'),
        Either.right({ kind: 'present', absolute: '/wt/apps/web' }),
      );
      assert.deepEqual(
        await scopeRoot(fs, 'apps/web/index.ts', 'file'),
        Either.right({ kind: 'present', absolute: '/wt/apps/web/index.ts' }),
      );
    });

    it('reports absent only once the existing prefix is proven', async () => {
      const fs = new FakeFs(insensitive);
      fs.put('apps/web', 'dir');
      assert.deepEqual(await scopeRoot(fs, 'apps/web/gone'), Either.right({ kind: 'absent' }));
      assert.deepEqual(await scopeRoot(fs, 'missing/deeper'), Either.right({ kind: 'absent' }));
    });

    it('an alias spelling is an alias only where the filesystem folds', async () => {
      const fs = new FakeFs(insensitive);
      fs.put('apps/web', 'dir');
      assert.deepEqual(
        await scopeRoot(fs, 'Apps/web'),
        Either.right(insensitive ? { kind: 'alias' } : { kind: 'absent' }),
      );
      assert.deepEqual(
        await scopeRoot(fs, 'apps/WEB'),
        Either.right(insensitive ? { kind: 'alias' } : { kind: 'absent' }),
      );
    });

    it('refuses a link at the root or at any ancestor, and a wrong kind', async () => {
      const fs = new FakeFs(insensitive);
      fs.put('link', 'symlink');
      fs.put('docs/readme.md', 'file');
      fs.put('pipe', 'fifo');
      assert.deepEqual(failureOf(await scopeRoot(fs, 'link')), {
        reason: 'scope_root_is_symlink',
        path: 'link',
      });
      assert.deepEqual(failureOf(await scopeRoot(fs, 'link/inner')), {
        reason: 'scope_root_is_symlink',
        path: 'link',
      });
      assert.deepEqual(failureOf(await scopeRoot(fs, 'docs/readme.md')), {
        reason: 'scope_kind_mismatch',
        path: 'docs/readme.md',
      });
      assert.deepEqual(failureOf(await scopeRoot(fs, 'docs', 'file')), {
        reason: 'scope_kind_mismatch',
        path: 'docs',
      });
      assert.deepEqual(failureOf(await scopeRoot(fs, 'docs/readme.md/x')), {
        reason: 'scope_kind_mismatch',
        path: 'docs/readme.md',
      });
      assert.deepEqual(failureOf(await scopeRoot(fs, 'pipe', 'file')), {
        reason: 'scope_kind_mismatch',
        path: 'pipe',
      });
    });

    it('checks existing exclusions for their exact spelling and ignores absent ones', async () => {
      const fs = new FakeFs(insensitive);
      fs.put('src/gen/out.js', 'file');
      assert.ok(Either.isRight(await scopeRoot(fs, 'src', 'directory', ['gen', 'not-there'])));
      const aliased = await scopeRoot(fs, 'src', 'directory', ['GEN']);
      if (insensitive) {
        assert.deepEqual(failureOf(aliased), {
          reason: 'scope_path_spelling_mismatch',
          path: 'src/GEN',
        });
      } else {
        assert.ok(Either.isRight(aliased));
      }
    });

    it('never treats a filesystem error other than not-found as absence', async () => {
      const fs = new FakeFs(insensitive);
      fs.put('covered/inner', 'dir');
      fs.failures.set('/wt/covered', 'EACCES');
      assert.deepEqual(failureOf(await scopeRoot(fs, 'covered/inner')), {
        reason: 'path_inspection_failed',
        path: 'covered',
      });
      fs.failures.set('/wt/covered', 'EIO');
      assert.deepEqual(failureOf(await scopeRoot(fs, 'covered')), {
        reason: 'path_inspection_failed',
        path: 'covered',
      });
    });
  });

  describe(`entry spelling classification on a ${label} filesystem`, () => {
    it('classifies verbatim, alias and absent through the listing, never a string fold', async () => {
      const fs = new FakeFs(insensitive);
      fs.put('docs/README.md', 'file');
      const snapshot = makeDirectorySnapshot(fs);
      const classify = (path: string) =>
        run(classifyEntrySpelling(snapshot, '/wt', path, 'authoritative'));
      assert.deepEqual(await classify('docs/README.md'), Either.right('verbatim'));
      assert.deepEqual(
        await classify('docs/readme.md'),
        Either.right(insensitive ? 'alias' : 'absent'),
      );
      assert.deepEqual(
        await classify('Docs/README.md'),
        Either.right(insensitive ? 'alias' : 'absent'),
      );
      assert.deepEqual(await classify('docs/other.md'), Either.right('absent'));
      // A `.GIT` spelling cannot reach the metadata entry: it is an alias, not the entry itself.
      fs.put('.git', 'file');
      assert.deepEqual(await classify('.GIT'), Either.right(insensitive ? 'alias' : 'absent'));
    });

    it('treats a path beneath a link or a file as absent, because links are never entered', async () => {
      const fs = new FakeFs(insensitive);
      fs.put('link', 'symlink');
      fs.put('file.txt', 'file');
      const snapshot = makeDirectorySnapshot(fs);
      assert.deepEqual(
        await run(classifyEntrySpelling(snapshot, '/wt', 'link/x', 'diagnostic')),
        Either.right('absent'),
      );
      assert.deepEqual(
        await run(classifyEntrySpelling(snapshot, '/wt', 'file.txt/x', 'diagnostic')),
        Either.right('absent'),
      );
    });

    it('memoizes listings for the whole capture', async () => {
      const fs = new FakeFs(insensitive);
      fs.put('docs/a.md', 'file');
      fs.put('docs/b.md', 'file');
      const snapshot = makeDirectorySnapshot(fs);
      await run(classifyEntrySpelling(snapshot, '/wt', 'docs/a.md', 'diagnostic'));
      await run(classifyEntrySpelling(snapshot, '/wt', 'docs/b.md', 'diagnostic'));
      assert.equal(fs.counts.readdir, 2);
    });
  });
}

describe('alias resolution', () => {
  it('names the unique verbatim entry an alias resolved to', async () => {
    const fs = new FakeFs(true);
    fs.put('docs/README.md', 'file');
    fs.put('docs/other.md', 'file');
    const result = await run(
      resolveAlias(makeDirectorySnapshot(fs), '/wt', 'docs/readme.md', 'authoritative'),
    );
    assert.deepEqual(result, Either.right({ kind: 'unique', entry: 'docs/README.md' }));
  });

  it('reports every hard-linked candidate instead of guessing', async () => {
    const fs = new FakeFs(true);
    const file = fs.put('docs/README.md', 'file');
    fs.put('docs/copy.md', 'file', file);
    const result = await run(
      resolveAlias(makeDirectorySnapshot(fs), '/wt', 'docs/readme.md', 'authoritative'),
    );
    assert.deepEqual(
      result,
      Either.right({ kind: 'ambiguous', entries: ['docs/README.md', 'docs/copy.md'] }),
    );
  });

  it('two verbatim hard links on a case-sensitive filesystem stay two entries', async () => {
    const fs = new FakeFs(false);
    const file = fs.put('README.md', 'file');
    fs.put('readme.md', 'file', file);
    const snapshot = makeDirectorySnapshot(fs);
    for (const path of ['README.md', 'readme.md']) {
      assert.deepEqual(
        await run(classifyEntrySpelling(snapshot, '/wt', path, 'authoritative')),
        Either.right('verbatim'),
      );
    }
  });
});

describe('directory snapshot revalidation', () => {
  it('passes when nothing the capture relied on changed', async () => {
    const fs = new FakeFs(false);
    fs.put('src/a.ts', 'file');
    const snapshot = makeDirectorySnapshot(fs);
    await run(resolveScopeRoot(snapshot, '/wt', 'src', 'directory', []));
    assert.deepEqual(await run(snapshot.revalidate()), Either.right(null));
  });

  it('catches a changed name set in an authoritative directory', async () => {
    const fs = new FakeFs(false);
    fs.put('src/a.ts', 'file');
    const snapshot = makeDirectorySnapshot(fs);
    await run(resolveScopeRoot(snapshot, '/wt', 'src', 'directory', []));
    fs.put('src/b.ts', 'file');
    assert.deepEqual(await run(snapshot.revalidate()), Either.right({ changed: '/wt/src' }));
  });

  it('catches a directory replaced by a link to an empty directory, whose names look unchanged', async () => {
    const fs = new FakeFs(false);
    fs.put('empty', 'dir');
    fs.put('src', 'dir');
    const snapshot = makeDirectorySnapshot(fs);
    await run(resolveScopeRoot(snapshot, '/wt', 'src', 'directory', []));
    fs.put('src', 'symlink');
    assert.deepEqual(await run(snapshot.revalidate()), Either.right({ changed: '/wt/src' }));
  });

  it('catches a directory replaced by another directory with the same names', async () => {
    const fs = new FakeFs(false);
    fs.put('src/a.ts', 'file');
    const snapshot = makeDirectorySnapshot(fs);
    await run(resolveScopeRoot(snapshot, '/wt', 'src', 'directory', []));
    fs.remove('src');
    fs.put('src/a.ts', 'file');
    assert.deepEqual(await run(snapshot.revalidate()), Either.right({ changed: '/wt/src' }));
  });

  it('catches an absent root that appeared, so an empty recapture cannot hide new content', async () => {
    const fs = new FakeFs(false);
    fs.put('docs', 'dir');
    const snapshot = makeDirectorySnapshot(fs);
    assert.deepEqual(
      await run(resolveScopeRoot(snapshot, '/wt', 'docs/gone', 'directory', [])),
      Either.right({ kind: 'absent' }),
    );
    fs.put('docs/gone/x.md', 'file');
    assert.deepEqual(await run(snapshot.revalidate()), Either.right({ changed: '/wt/docs' }));
  });

  it('ignores directories read only diagnostically', async () => {
    const fs = new FakeFs(false);
    fs.put('dirty/a.txt', 'file');
    const snapshot = makeDirectorySnapshot(fs);
    await run(classifyEntrySpelling(snapshot, '/wt', 'dirty/a.txt', 'diagnostic'));
    fs.put('dirty/b.txt', 'file');
    assert.deepEqual(await run(snapshot.revalidate()), Either.right(null));
  });

  it('reports a read failure during revalidation as an error, never as unchanged', async () => {
    const fs = new FakeFs(false);
    fs.put('src', 'dir');
    const snapshot = makeDirectorySnapshot(fs);
    await run(resolveScopeRoot(snapshot, '/wt', 'src', 'directory', []));
    fs.failures.set('/wt/src', 'EACCES');
    const result = await run(snapshot.revalidate());
    assert.ok(Either.isLeft(result));
    assert.equal(result.left._tag, 'PathInspectionError');
  });
});

describe('native directory reader', () => {
  const base = mkdtempSync(join(tmpdir(), 'isagi-path-identity-'));
  after(() => rmSync(base, { recursive: true, force: true }));
  const worktree = join(base, 'worktree');
  mkdirSync(join(worktree, 'apps'), { recursive: true });
  writeFileSync(join(worktree, 'apps', 'file.txt'), 'x');
  symlinkSync(join(worktree, 'apps'), join(worktree, 'linked'));
  const root = realpathSync(worktree);
  const hostInsensitive = (() => {
    try {
      realpathSync(join(worktree, 'APPS'));
      return true;
    } catch {
      return false;
    }
  })();

  it('resolves, refuses links and classifies spelling on the host filesystem', async () => {
    const snapshot = makeDirectorySnapshot(nodeDirectoryReader);
    assert.deepEqual(
      await run(resolveScopeRoot(snapshot, root, 'apps', 'directory', [])),
      Either.right({ kind: 'present', absolute: join(root, 'apps') }),
    );
    const linked = await run(resolveScopeRoot(snapshot, root, 'linked', 'directory', []));
    assert.ok(Either.isLeft(linked) && linked.left.reason === 'scope_root_is_symlink');
    assert.deepEqual(
      await run(classifyEntrySpelling(snapshot, root, 'APPS/file.txt', 'authoritative')),
      Either.right(hostInsensitive ? 'alias' : 'absent'),
    );
    assert.deepEqual(await run(snapshot.revalidate()), Either.right(null));
  });
});
