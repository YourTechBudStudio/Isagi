/**
 * Reconstruction: each checkpoint's stored inventory, applied to a fresh worktree at that
 * checkpoint's own base (or an empty directory without one), reproduces what was declared — in
 * either order of writing files and removing absences, because the two never name the same entry.
 */

import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { run } from '../persistence/test-support.js';
import { makeCaptureHarness, treeOf, type CaptureHarness } from './capture.test-support.js';

let harness: CaptureHarness;
afterEach(() => harness?.close());

const dir = (scope: string, directory: string, exclude?: string[]) =>
  exclude ? { scope, directory, exclude } : { scope, directory };

/** Rebuild in both orders, require they agree, and return the reconstructed tree. */
async function rebuilt(record: Parameters<CaptureHarness['rebuild']>[0], under?: string[]) {
  const filesFirst = treeOf(await harness.rebuild(record, 'files_first'), under);
  const absencesFirst = treeOf(await harness.rebuild(record, 'absences_first'), under);
  assert.deepEqual(absencesFirst, filesFirst, 'both application orders must agree');
  return filesFirst;
}

describe('reconstruction', () => {
  it('reproduces layered scopes across changed bases and exclusion changes', async () => {
    harness = makeCaptureHarness();
    harness.write('src/a.ts', 'a1');
    harness.write('src/b.ts', 'b1');
    harness.write('src/gen/g.ts', 'g1');
    harness.write('docs/x.md', 'x1');
    harness.write('docs/y.md', 'y1');
    harness.write('keep.md', 'keep');
    const commitA = harness.commitAll('A');

    // Layer 1 on A: modified, added (executable) and deleted files in two scopes.
    harness.write('src/a.ts', 'a2');
    harness.write('src/new.ts', 'new', true);
    harness.remove('src/b.ts');
    harness.write('docs/x.md', 'x2');
    const first = await harness.captureOk([dir('src', 'src'), dir('docs', 'docs')]);
    assert.deepEqual(await rebuilt(first), treeOf(harness.repo));

    // Layer 2 on B: only docs recaptured; src is inherited and B already agrees with it.
    harness.commitAll('B');
    harness.remove('docs/y.md');
    harness.write('docs/z.md', 'z');
    const second = await harness.captureOk([dir('docs', 'docs')]);
    assert.equal(second.parentCheckpointId, first.id);
    assert.deepEqual(await rebuilt(second), treeOf(harness.repo));

    // Layer 3 back on A: docs recaptured there, src inherited from layer 1. The absence of
    // `src/b.ts` is recomputed against A, which tracks it, so layer 1's deletion survives the move.
    harness.commitAll('C');
    harness.git(['checkout', '--quiet', '--detach', commitA]);
    const third = await harness.captureOk([dir('docs', 'docs')]);
    assert.deepEqual(third.base, {
      kind: 'git',
      repositoryId: harness.projectId,
      commitSha: commitA,
    });
    assert.ok(
      harness.entries(third.id).some((row) => row.kind === 'absent' && row.path === 'src/b.ts'),
    );
    assert.deepEqual(await rebuilt(third), {
      ...(await rebuilt(first, ['src'])),
      ...treeOf(harness.repo, ['docs', 'keep.md']),
    });

    // Layer 4 on A: the same src scope now excludes gen. Its inherited gen files leave the
    // inventory and gen is no longer covered, so the base supplies it.
    const fourth = await harness.captureOk([dir('src', 'src', ['gen'])]);
    assert.ok(
      !harness
        .entries(fourth.id)
        .some((row) => row.kind === 'file' && row.path.startsWith('src/gen/')),
    );
    assert.deepEqual(await rebuilt(fourth), {
      ...treeOf(harness.repo, ['src']),
      ...treeOf(await harness.rebuild(third, 'files_first'), ['docs', 'keep.md']),
    });
  });

  it('reproduces a mode-only change and a deletion of a whole tracked directory', async () => {
    harness = makeCaptureHarness();
    harness.write('bin/run', '#!/bin/sh');
    harness.write('old/a.md', 'a');
    harness.write('old/deep/b.md', 'b');
    harness.commitAll('base');
    chmodSync(join(harness.repo, 'bin/run'), 0o755);
    harness.remove('old');
    const record = await harness.captureOk([dir('bin', 'bin'), dir('old', 'old')]);
    assert.deepEqual(await rebuilt(record), treeOf(harness.repo));
  });

  it('reproduces an unborn repository and a folder project from an empty directory', async () => {
    harness = makeCaptureHarness();
    harness.write('notes/a.md', 'a');
    harness.write('notes/sub/b.md', 'b', true);
    const unborn = await harness.captureOk([dir('notes', 'notes')]);
    assert.deepEqual(unborn.base, { kind: 'none', reason: 'unborn_repository' });
    assert.deepEqual(await rebuilt(unborn), treeOf(harness.repo, ['notes']));
    harness.close();

    harness = makeCaptureHarness({ kind: 'folder' });
    harness.write('site/index.html', 'index');
    harness.write('assets/logo.svg', 'logo');
    await harness.captureOk([dir('site', 'site')]);
    harness.write('site/about.html', 'about');
    harness.remove('site/index.html');
    const layered = await harness.captureOk([dir('assets', 'assets')]);
    // The folder has no base, so layer 2 inherits layer 1's site exactly as it was then.
    assert.deepEqual(await rebuilt(layered), {
      'assets/logo.svg': { content: 'logo', executable: false },
      'site/index.html': { content: 'index', executable: false },
    });
  });

  it('captures from a linked worktree, reading its own HEAD and survey beside its .git file', async () => {
    harness = makeCaptureHarness();
    harness.write('src/keep.ts', 'keep');
    harness.write('src/edit.ts', 'edit v1');
    harness.write('src/gone.ts', 'gone');
    harness.write('other.md', 'other v1');
    const mainHead = harness.commitAll('main base');

    // A linked checkout on its own branch, one commit ahead, so its HEAD differs from the main
    // checkout's. Its root `.git` is a file naming the main repository's metadata.
    const linked = join(harness.workspace.root, 'linked');
    harness.git(['worktree', 'add', '--quiet', '-b', 'linked', linked]);
    const inLinked = (args: readonly string[]) => harness.workspace.git(linked, args);
    const put = (path: string, content: string) => {
      mkdirSync(dirname(join(linked, path)), { recursive: true });
      writeFileSync(join(linked, path), content);
    };
    put('src/linked-only.ts', 'linked');
    inLinked(['add', '-A']);
    inLinked(['commit', '--quiet', '-m', 'linked commit']);
    const linkedHead = inLinked(['rev-parse', 'HEAD']).trim();
    assert.notEqual(linkedHead, mainHead);
    assert.ok(lstatSync(join(linked, '.git')).isFile());

    // The linked checkout is the run's destination; the project row keeps the main repository.
    harness.fixture.client
      .prepare('UPDATE worktrees SET path = ? WHERE id = ?')
      .run(linked, harness.worktreeId);

    put('src/edit.ts', 'edit v2');
    put('src/new.ts', 'new');
    rmSync(join(linked, 'src/gone.ts'));
    put('other.md', 'other v2, undeclared');

    const record = await harness.captureOk([dir('src', 'src')]);
    assert.deepEqual(record.base, {
      kind: 'git',
      repositoryId: harness.projectId,
      commitSha: linkedHead,
    });
    assert.equal(record.repositoryRootPath, harness.repo);

    const rows = harness.entries(record.id);
    assert.deepEqual(
      rows.flatMap((row) => (row.kind === 'file' ? [row.path] : [])),
      ['src/edit.ts', 'src/keep.ts', 'src/linked-only.ts', 'src/new.ts'],
    );
    assert.deepEqual(
      rows.flatMap((row) => (row.kind === 'absent' ? [row.path] : [])),
      ['src/gone.ts'],
    );
    assert.deepEqual(
      rows.flatMap((row) => (row.kind === 'change' ? [`${row.operation} ${row.path}`] : [])),
      ['modify src/edit.ts', 'delete src/gone.ts', 'add src/new.ts'],
    );
    assert.deepEqual(
      rows.flatMap((row) => (row.kind === 'warning' ? [[row.reason, row.path]] : [])),
      [
        ['ignored_paths_not_surveyed', null],
        ['uncaptured_dirty_path', 'other.md'],
      ],
    );
    assert.ok(
      rows.every(
        (row) => !('path' in row) || row.path === null || !row.path.split('/').includes('.git'),
      ),
      'no row names the checkout’s .git file',
    );

    // The undeclared edit is not saved, so reconstruction gives that path the base's content.
    assert.deepEqual(await rebuilt(record), {
      ...treeOf(linked),
      'other.md': { content: 'other v1', executable: false },
    });
  });
});

describe('history outlives its sources', () => {
  it('keeps the checkpoint and its inventory readable after Git discards the base commit', async () => {
    harness = makeCaptureHarness();
    harness.write('readme.md', 'main');
    harness.commitAll('main');
    harness.git(['checkout', '--quiet', '-b', 'feature']);
    harness.write('docs/a.md', 'feature');
    const discarded = harness.commitAll('feature');
    harness.write('docs/a.md', 'dirty');
    const record = await harness.captureOk([dir('docs', 'docs')]);

    // Move HEAD to a surviving commit first; detaching at the checkpoint's commit would keep it
    // reachable. Then make it unreachable and collect. Whether this Git prunes it is not asserted.
    harness.remove('docs');
    harness.git(['checkout', '--quiet', 'main']);
    harness.git(['branch', '--quiet', '-D', 'feature']);
    harness.git(['reflog', 'expire', '--expire=now', '--all']);
    harness.git(['gc', '--quiet', '--prune=now']);

    const found = await run(harness.repository.findByExecution(record.executionId));
    assert.deepEqual(found?.base, {
      kind: 'git',
      repositoryId: harness.projectId,
      commitSha: discarded,
    });
    const state = await run(harness.repository.resolvedStateOf(record.id));
    assert.deepEqual([...state.files.keys()], ['docs/a.md']);
    const bytes = await run(
      harness.fixture.content.readAll(state.files.get('docs/a.md')!.contentRef),
    );
    assert.equal(bytes.toString('utf8'), 'dirty');
  });

  it('keeps checkpoint history and retention facts after the worktree row is removed', async () => {
    harness = makeCaptureHarness();
    harness.write('docs/a.md', 'a');
    harness.write('docs/b.md', 'b');
    const record = await harness.captureOk([dir('docs', 'docs')]);
    harness.fixture.client.prepare('DELETE FROM worktrees WHERE id = ?').run(harness.worktreeId);

    assert.equal(harness.checkpointCount(), 1);
    const retention = await run(harness.repository.listRetentionForRuns([record.runId]));
    const fileRefs = harness
      .entries(record.id)
      .flatMap((row) => (row.kind === 'file' ? [row.contentRef] : []));
    assert.deepEqual(retention, [
      {
        checkpointKey: record.checkpointKey,
        repositoryProjectId: harness.projectId,
        contentRefs: [...new Set(fileRefs)].sort(),
      },
    ]);
  });
});
