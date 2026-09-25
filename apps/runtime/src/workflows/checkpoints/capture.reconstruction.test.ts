/**
 * Reconstruction through the production path: each checkpoint, exported with `checkpoints export`
 * over the real routes into a fresh worktree at its own base (or an empty directory without one),
 * reproduces what was declared.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { contentPathFor } from '../persistence/content-store.js';
import { run } from '../persistence/test-support.js';
import { makeCaptureHarness, treeOf, type CaptureHarness } from './capture.test-support.js';

let harness: CaptureHarness;
afterEach(() => harness?.close());

const dir = (scope: string, directory: string, exclude?: string[]) =>
  exclude ? { scope, directory, exclude } : { scope, directory };

/**
 * Export the checkpoint and return the reconstructed tree. Export applies absences before files;
 * that order is only safe because no inventory path is both, so that is checked directly.
 */
async function rebuilt(record: Parameters<CaptureHarness['exported']>[0], under?: string[]) {
  const entries = await harness.inventory(record);
  const files = new Set(entries.flatMap((entry) => (entry.kind === 'file' ? [entry.path] : [])));
  const both = entries.filter((entry) => entry.kind === 'absent' && files.has(entry.path));
  assert.deepEqual(both, [], 'no inventory path is both a file and an absence');
  return treeOf(await harness.exported(record), under);
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
      ...treeOf(await harness.exported(third), ['docs', 'keep.md']),
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

/** Everything about a checkout an export must not change: Git's view of it and its bytes. */
function checkoutState(root: string, git: (args: readonly string[]) => string) {
  const bytes: Record<string, string> = {};
  const walk = (relative: string) => {
    for (const name of readdirSync(join(root, relative)).sort()) {
      if (relative === '' && name === '.git') continue;
      const child = relative === '' ? name : `${relative}/${name}`;
      const stats = lstatSync(join(root, child));
      if (stats.isDirectory()) walk(child);
      else bytes[child] = `${stats.mode.toString(8)} ${readFileSync(join(root, child), 'base64')}`;
    }
  };
  walk('');
  return {
    head: git(['rev-parse', 'HEAD']),
    branches: git(['branch', '--list', '--all', '--format=%(refname) %(objectname)']),
    status: git(['status', '--porcelain', '--untracked-files=all']),
    bytes,
  };
}

describe('export through the real routes', () => {
  it('leaves the source checkout unchanged and reports a complete Git export', async () => {
    harness = makeCaptureHarness();
    harness.write('src/a.ts', 'a1');
    harness.write('src/b.ts', 'b1');
    harness.commitAll('base');
    harness.write('src/a.ts', 'a2');
    harness.remove('src/b.ts');
    harness.write('notes.md', 'undeclared dirt');
    const record = await harness.captureOk([dir('src', 'src')]);
    const before = checkoutState(harness.repo, harness.git);

    // Deliberately not canonicalized: on macOS `os.tmpdir()` sits behind a symlink, so this also
    // proves the CLI's canonical path and the one the runtime returns agree.
    const destination = join(tmpdir(), `isagi-export-e2e-${randomUUID()}`, 'root');
    try {
      const { result } = await harness.exportCheckpoint(record, destination);
      assert.equal(result.status, 'complete', JSON.stringify(result.failure));
      assert.deepEqual(result.base, record.base);
      assert.equal(typeof result.worktreeId, 'number');
      assert.deepEqual(result.limitations, [
        'git_baseline_is_committed_state_only',
        'dependencies_not_captured',
      ]);
      assert.equal(result.failure, null);
      assert.deepEqual(treeOf(result.destinationPath), {
        'src/a.ts': { content: 'a2', executable: false },
      });
      // The new worktree is detached at the checkpoint's own commit, with no branch.
      const exportedHead = harness.workspace
        .git(result.destinationPath, ['rev-parse', 'HEAD'])
        .trim();
      assert.equal(exportedHead, (record.base as { commitSha: string }).commitSha);
      assert.equal(
        harness.workspace.git(result.destinationPath, ['branch', '--show-current']).trim(),
        '',
      );

      const after = checkoutState(harness.repo, harness.git);
      assert.equal(after.head, before.head);
      assert.equal(after.branches, before.branches);
      assert.equal(after.status, before.status);
      assert.deepEqual(after.bytes, before.bytes);
    } finally {
      rmSync(dirname(destination), { recursive: true, force: true });
    }
  });

  it('prunes a tracked directory whose only file the checkpoint deleted (R5)', async () => {
    harness = makeCaptureHarness();
    harness.write('src/keep.ts', 'keep');
    harness.write('src/lonely/only.ts', 'only');
    harness.commitAll('base');
    harness.remove('src/lonely');
    const record = await harness.captureOk([dir('src', 'src')]);
    const root = await harness.exported(record);
    assert.ok(!existsSync(join(root, 'src/lonely')), 'the emptied directory is removed');
    assert.deepEqual(treeOf(root), { 'src/keep.ts': { content: 'keep', executable: false } });
  });

  it('fails before creating anything when Git has discarded the base commit', async () => {
    harness = makeCaptureHarness();
    harness.write('readme.md', 'main');
    harness.commitAll('main');
    harness.git(['checkout', '--quiet', '-b', 'feature']);
    harness.write('docs/a.md', 'feature');
    harness.commitAll('feature');
    const record = await harness.captureOk([dir('docs', 'docs')]);
    harness.remove('docs');
    harness.git(['checkout', '--quiet', 'main']);
    harness.git(['branch', '--quiet', '-D', 'feature']);
    harness.git(['reflog', 'expire', '--expire=now', '--all']);
    harness.git(['gc', '--quiet', '--prune=now']);
    const commit = (record.base as { commitSha: string }).commitSha;
    const pruned = (() => {
      try {
        harness.git(['cat-file', '-e', `${commit}^{commit}`]);
        return false;
      } catch {
        return true;
      }
    })();
    if (!pruned) return; // This Git kept the commit; there is nothing to prove here.

    const { result, destination } = await harness.exportCheckpoint(record);
    assert.equal(result.status, 'failed');
    assert.equal(result.failure?.stage, 'prepare_baseline');
    assert.equal(result.failure?.code, 'workflow_rejected');
    assert.equal(result.failure?.reason, 'workflow_checkpoint_commit_unavailable');
    assert.deepEqual(result.failure?.created, { destination: false, worktreeId: null });
    assert.ok(!existsSync(destination), 'no destination was created');
  });

  it('keeps the worktree and reports it when a saved file is corrupt', async () => {
    harness = makeCaptureHarness();
    harness.write('docs/a.md', 'a');
    harness.commitAll('base');
    harness.write('docs/a.md', 'a changed');
    harness.write('docs/b.md', 'b new');
    const record = await harness.captureOk([dir('docs', 'docs')]);
    const saved = harness
      .entries(record.id)
      .find((row) => row.kind === 'file' && row.path === 'docs/b.md') as { contentRef: string };
    writeFileSync(contentPathFor(harness.fixture.contentRoot, saved.contentRef), 'tampered');

    const { result } = await harness.exportCheckpoint(record);
    assert.equal(result.status, 'failed');
    assert.equal(result.failure?.stage, 'write_files');
    assert.equal(result.failure?.reason, 'workflow_checkpoint_content_unavailable');
    assert.equal(typeof result.worktreeId, 'number');
    assert.deepEqual(result.failure?.created, { destination: true, worktreeId: result.worktreeId });
    assert.ok(existsSync(join(result.destinationPath, '.git')), 'the worktree is left in place');
    assert.ok(!existsSync(join(result.destinationPath, 'docs/b.md')));
  });

  it('refuses a folder-project export into its own source, leaving the source unchanged', async () => {
    harness = makeCaptureHarness({ kind: 'folder' });
    harness.write('site/index.html', 'index');
    const record = await harness.captureOk([dir('site', 'site')]);
    const before = treeOf(harness.repo);

    const { result, destination } = await harness.exportCheckpoint(
      record,
      join(harness.repo, 'experiment'),
    );
    assert.equal(result.status, 'failed');
    assert.equal(result.failure?.stage, 'resolve_destination');
    assert.equal(result.failure?.code, 'export_destination_rejected');
    assert.equal(
      (result.failure!.data as { destinationIssue: string }).destinationIssue,
      'inside_checkout',
    );
    assert.ok(!existsSync(destination));
    assert.deepEqual(treeOf(harness.repo), before);
  });

  it('reports a complete directory-only export with its limitation', async () => {
    harness = makeCaptureHarness({ kind: 'folder' });
    harness.write('site/run.sh', '#!/bin/sh', true);
    const record = await harness.captureOk([dir('site', 'site')]);
    const { result } = await harness.exportCheckpoint(record);
    assert.equal(result.status, 'complete');
    assert.equal(result.worktreeId, null);
    assert.deepEqual(result.base, { kind: 'none', reason: 'folder_project' });
    assert.deepEqual(result.limitations, [
      'no_baseline_captured_files_only',
      'dependencies_not_captured',
    ]);
    assert.deepEqual(treeOf(result.destinationPath), {
      'site/run.sh': { content: '#!/bin/sh', executable: true },
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
