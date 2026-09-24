import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';

import { Effect, Exit } from 'effect';

import { GitCommandError, type GitService } from '../../git/git.command.js';
import { nodeDirectoryReader } from '../paths.js';
import type { WorkflowContentStoreService } from '../persistence/content-store.js';
import {
  foldingReader,
  hookedReader,
  liveGit,
  makeCaptureHarness,
  type CaptureHarness,
} from './capture.test-support.js';
import { makeWorkflowCheckpointRepository } from './checkpoints.repository.js';

let harness: CaptureHarness;
afterEach(() => {
  mock.restoreAll();
  harness?.close();
});

const dir = (scope: string, directory: string, exclude?: string[]) =>
  exclude ? { scope, directory, exclude } : { scope, directory };
const file = (scope: string, path: string) => ({ scope, file: path });

/** Rows of one kind, reduced to what an assertion compares. */
function rows(checkpointId: number) {
  const all = harness.entries(checkpointId);
  return {
    files: all.flatMap((row) => (row.kind === 'file' ? [[row.path, row.executable] as const] : [])),
    absences: all.flatMap((row) => (row.kind === 'absent' ? [row.path] : [])),
    changes: all.flatMap((row) =>
      row.kind === 'change' ? [[row.operation, row.path] as const] : [],
    ),
    warnings: all.flatMap((row) =>
      row.kind === 'warning' ? [[row.reason, row.path] as const] : [],
    ),
    scopes: all.flatMap((row) => (row.kind === 'scope' ? [[row.scopeId, row.path] as const] : [])),
  };
}

/** Whether this host's temporary directory folds case, for the native alias test. */
const isCaseInsensitiveHost = (() => {
  const scratch = mkdtempSync(join(tmpdir(), 'isagi-case-probe-'));
  try {
    writeFileSync(join(scratch, 'probe'), '');
    return existsSync(join(scratch, 'PROBE'));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
})();

describe('a checkpoint over a committed base', () => {
  it('saves declared files, records tracked deletions as absences and classifies changes against the base', async () => {
    harness = makeCaptureHarness();
    harness.write('docs/keep.md', 'keep');
    harness.write('docs/edit.md', 'before');
    harness.write('docs/gone.md', 'gone');
    harness.write('docs/tool.sh', '#!/bin/sh', false);
    harness.write('other.md', 'other');
    const sha = harness.commitAll('base');

    harness.write('docs/edit.md', 'after');
    harness.write('docs/new.md', 'new');
    harness.remove('docs/gone.md');
    chmodSync(join(harness.repo, 'docs/tool.sh'), 0o755);
    harness.write('other.md', 'dirty but undeclared');

    const record = await harness.captureOk([dir('docs', 'docs')]);
    assert.deepEqual(record.base, { kind: 'git', repositoryId: harness.projectId, commitSha: sha });
    assert.equal(record.parentCheckpointId, null);
    assert.equal(record.repositoryRootPath, harness.repo);
    const stored = rows(record.id);
    assert.deepEqual(stored.files, [
      ['docs/edit.md', false],
      ['docs/keep.md', false],
      ['docs/new.md', false],
      ['docs/tool.sh', true],
    ]);
    assert.deepEqual(stored.absences, ['docs/gone.md']);
    assert.deepEqual(stored.changes, [
      ['modify', 'docs/edit.md'],
      ['delete', 'docs/gone.md'],
      ['add', 'docs/new.md'],
      ['modify', 'docs/tool.sh'],
    ]);
    assert.deepEqual(stored.warnings, [
      ['ignored_paths_not_surveyed', null],
      ['uncaptured_dirty_path', 'other.md'],
    ]);
  });

  it('captures ignored files inside a scope and reports an excluded dirty path as uncaptured', async () => {
    harness = makeCaptureHarness();
    harness.write('.gitignore', 'build/\n');
    harness.write('app/src/main.ts', 'main');
    harness.write('app/gen/out.ts', 'gen');
    harness.commitAll('base');
    harness.write('app/build/bundle.js', 'ignored but declared');
    harness.write('app/gen/out.ts', 'regenerated');

    const record = await harness.captureOk([dir('app', 'app', ['gen'])]);
    const stored = rows(record.id);
    assert.deepEqual(stored.files, [
      ['app/build/bundle.js', false],
      ['app/src/main.ts', false],
    ]);
    // The excluded region is not coverage, so its tracked file is left to the base, not deleted.
    assert.deepEqual(stored.absences, []);
    assert.deepEqual(stored.warnings, [
      ['ignored_paths_not_surveyed', null],
      ['uncaptured_dirty_path', 'app/gen/out.ts'],
    ]);
  });

  it('skips links, special files and nested repositories, and never turns them into absences', async () => {
    harness = makeCaptureHarness();
    harness.write('src/linked.md', 'tracked file, later a link');
    harness.write('src/plain.md', 'plain');
    harness.commitAll('base');
    harness.remove('src/linked.md');
    symlinkSync('plain.md', join(harness.repo, 'src/linked.md'));
    execFileSync('mkfifo', [join(harness.repo, 'src/pipe')]);
    mkdirSync(join(harness.repo, 'src/vendor'));
    harness.workspace.git(join(harness.repo, 'src/vendor'), ['init', '--quiet']);
    harness.write('src/vendor/lib.md', 'vendored');

    const record = await harness.captureOk([dir('src', 'src')]);
    const stored = rows(record.id);
    assert.deepEqual(stored.files, [
      ['src/plain.md', false],
      ['src/vendor/lib.md', false],
    ]);
    assert.deepEqual(stored.absences, []);
    assert.deepEqual(
      stored.changes.map(([operation, path]) => `${operation} ${path}`),
      ['add src/vendor/lib.md'],
    );
    assert.deepEqual(
      stored.warnings.filter(([reason]) => reason !== 'uncaptured_dirty_path'),
      [
        ['symlink_skipped', 'src/linked.md'],
        ['special_file_skipped', 'src/pipe'],
        ['nested_repository_skipped', 'src/vendor/.git'],
        ['ignored_paths_not_surveyed', null],
      ],
    );
  });

  it('refuses a directory that replaced a tracked file as a kind conflict', async () => {
    harness = makeCaptureHarness();
    harness.write('cfg/app', 'a file');
    harness.commitAll('base');
    harness.remove('cfg/app');
    harness.write('cfg/app/inner.json', '{}');
    const failure = await harness.refusal([dir('cfg', 'cfg')]);
    assert.equal(failure.reason, 'path_kind_conflict');
    assert.equal(failure.path, 'cfg/app');
    assert.equal(harness.checkpointCount(), 0);
  });
});

describe('missing scope roots', () => {
  it('recaptures a deleted tracked directory as empty when declared under Git’s spelling', async () => {
    harness = makeCaptureHarness();
    harness.write('old/a.md', 'a');
    harness.write('old/b/c.md', 'c');
    harness.commitAll('base');
    harness.remove('old');
    const record = await harness.captureOk([dir('old', 'old')]);
    const stored = rows(record.id);
    assert.deepEqual(stored.files, []);
    assert.deepEqual(stored.absences, ['old/a.md', 'old/b/c.md']);
    assert.ok(
      stored.warnings.some(
        ([reason, path]) => reason === 'scope_recaptured_empty' && path === 'old',
      ),
    );
  });

  it('recaptures a removed subdirectory of inherited coverage as empty, dropping its inherited files', async () => {
    harness = makeCaptureHarness();
    harness.write('docs/top.md', 'top');
    harness.commitAll('base');
    harness.write('docs/sub/draft.md', 'draft');
    const first = await harness.captureOk([dir('docs', 'docs')]);
    assert.deepEqual(
      rows(first.id).files.map(([path]) => path),
      ['docs/sub/draft.md', 'docs/top.md'],
    );
    harness.remove('docs/sub');
    const second = await harness.captureOk([dir('sub', 'docs/sub')]);
    assert.equal(second.parentCheckpointId, first.id);
    assert.deepEqual(
      rows(second.id).files.map(([path]) => path),
      ['docs/top.md'],
    );
  });

  it('refuses a missing root that is neither covered nor tracked', async () => {
    harness = makeCaptureHarness();
    harness.commitAll('base');
    const failure = await harness.refusal([dir('typo', 'dosc')]);
    assert.equal(failure.reason, 'scope_path_not_found');
    assert.equal(failure.scopeId, 'typo');
  });

  it('refuses a symlinked root and a root of the wrong kind', async () => {
    harness = makeCaptureHarness();
    harness.write('real/a.md', 'a');
    symlinkSync('real', join(harness.repo, 'link'));
    assert.equal((await harness.refusal([dir('link', 'link')])).reason, 'scope_root_is_symlink');
    assert.equal((await harness.refusal([file('real', 'real')])).reason, 'scope_kind_mismatch');
    assert.equal(harness.checkpointCount(), 0);
  });
});

describe('scope identity', () => {
  it('lets a scope change its exclusions but refuses a new root under the same id before publishing', async () => {
    harness = makeCaptureHarness();
    harness.write('app/src/a.ts', 'a');
    harness.write('app/gen/b.ts', 'b');
    harness.write('lib/c.ts', 'c');
    const first = await harness.captureOk([dir('app', 'app')]);
    const second = await harness.captureOk([dir('app', 'app', ['gen'])]);
    assert.equal(second.parentCheckpointId, first.id);
    assert.deepEqual(
      rows(second.id).files.map(([path]) => path),
      ['app/src/a.ts'],
    );

    const put = mock.fn(harness.fixture.content.put);
    const failure = await harness.refusal([dir('app', 'lib')], {
      content: { ...harness.fixture.content, put },
    });
    assert.equal(failure.reason, 'scope_identity_changed');
    assert.equal(put.mock.callCount(), 0);
  });
});

describe('projects without a commit base', () => {
  it('captures an unborn repository with no base and surveys it', async () => {
    harness = makeCaptureHarness();
    harness.write('notes/a.md', 'a');
    harness.write('loose.md', 'loose');
    const record = await harness.captureOk([dir('notes', 'notes')]);
    assert.deepEqual(record.base, { kind: 'none', reason: 'unborn_repository' });
    const stored = rows(record.id);
    assert.deepEqual(stored.files, [['notes/a.md', false]]);
    assert.deepEqual(stored.warnings, [
      ['ignored_paths_not_surveyed', null],
      ['uncaptured_dirty_path', 'loose.md'],
    ]);
  });

  it('refuses an unborn repository that received its first commit during capture', async () => {
    harness = makeCaptureHarness();
    harness.write('notes/a.md', 'a');
    const failure = await harness.refusal([dir('notes', 'notes')], {
      git: commitBeforeSecondHeadRead(() => harness.commitAll('first')),
    });
    assert.equal(failure.reason, 'head_changed');
    assert.equal(harness.checkpointCount(), 0);
  });

  it('captures a folder project with no Git reads and no Git warnings', async () => {
    harness = makeCaptureHarness({ kind: 'folder' });
    harness.write('site/index.html', '<p>');
    const neverGit: GitService = { run: () => Effect.die('a folder capture must not run Git') };
    const record = await harness.captureOk([dir('site', 'site')], { git: neverGit });
    assert.deepEqual(record.base, { kind: 'none', reason: 'folder_project' });
    assert.deepEqual(rows(record.id).warnings, []);
  });

  it('still revalidates the directories of a folder project', async () => {
    harness = makeCaptureHarness({ kind: 'folder' });
    harness.write('site/index.html', '<p>');
    const failure = await harness.refusal([dir('site', 'site')], {
      content: afterPut(harness.fixture.content, () => harness.write('site/late.html', 'late')),
    });
    assert.equal(failure.reason, 'unstable_capture');
    assert.equal(failure.path, 'site');
  });
});

describe('Git failures', () => {
  it('refuses when Git cannot start, and when a load-bearing read fails', async () => {
    harness = makeCaptureHarness();
    harness.write('a/b.md', 'b');
    const failing = (failure: GitCommandError['failure']): GitService => ({
      run: (args) =>
        Effect.fail(
          new GitCommandError({ args, cause: undefined, cwd: undefined, failure, stderr: '' }),
        ),
    });
    assert.equal(
      (
        await harness.refusal([dir('a', 'a')], {
          git: failing({ kind: 'spawn_failed', systemErrorCode: 'ENOENT' }),
        })
      ).reason,
      'git_unavailable',
    );
    assert.equal(
      (await harness.refusal([dir('a', 'a')], { git: failing({ kind: 'exited', exitCode: 128 }) }))
        .reason,
      'git_inspection_failed',
    );
    assert.equal(harness.checkpointCount(), 0);
  });

  it('keeps capturing with a warning when only the dirty survey fails', async () => {
    harness = makeCaptureHarness();
    harness.write('a/b.md', 'b');
    const surveyFails: GitService = {
      run: (args, options) =>
        args.includes('status')
          ? Effect.fail(
              new GitCommandError({
                args,
                cause: undefined,
                cwd: undefined,
                failure: { kind: 'exited', exitCode: 128 },
                stderr: '',
              }),
            )
          : liveGit.run(args, options),
    };
    const record = await harness.captureOk([dir('a', 'a')], { git: surveyFails });
    assert.deepEqual(rows(record.id).warnings, [
      ['dirty_survey_unavailable', null],
      ['ignored_paths_not_surveyed', null],
    ]);
  });

  it('refuses when HEAD moves during capture', async () => {
    harness = makeCaptureHarness();
    harness.write('a/b.md', 'b');
    harness.commitAll('base');
    const failure = await harness.refusal([dir('a', 'a')], {
      git: commitBeforeSecondHeadRead(() => harness.commitAll('moved')),
    });
    assert.equal(failure.reason, 'head_changed');
  });
});

describe('stability', () => {
  it('refuses a file that grew between its first lstat and its handle checks', async () => {
    harness = makeCaptureHarness();
    harness.write('a/b.md', 'b');
    const target = join(harness.repo, 'a/b.md');
    const failure = await harness.refusal([dir('a', 'a')], {
      directoryReader: hookedReader(target, () => writeFileSync(target, 'grown bytes')),
    });
    assert.equal(failure.reason, 'unstable_capture');
    assert.equal(failure.path, 'a/b.md');
  });

  it('refuses a file whose mode changed after its bytes were streamed', async () => {
    harness = makeCaptureHarness();
    harness.write('a/b.sh', '#!/bin/sh');
    const failure = await harness.refusal([dir('a', 'a')], {
      content: afterPut(harness.fixture.content, () =>
        chmodSync(join(harness.repo, 'a/b.sh'), 0o755),
      ),
    });
    assert.equal(failure.reason, 'unstable_capture');
    assert.equal(failure.path, 'a/b.sh');
  });

  it('refuses a directory whose entries changed after it was walked', async () => {
    harness = makeCaptureHarness();
    harness.write('a/b.md', 'b');
    const failure = await harness.refusal([dir('a', 'a')], {
      content: afterPut(harness.fixture.content, () => harness.write('a/c.md', 'late')),
    });
    assert.equal(failure.reason, 'unstable_capture');
    assert.equal(failure.path, 'a');
  });

  it('refuses a directory replaced by a link to an identical directory', async () => {
    harness = makeCaptureHarness();
    harness.write('a/b.md', 'b');
    const outside = harness.workspace.directory('outside');
    const failure = await harness.refusal([dir('a', 'a')], {
      content: afterPut(harness.fixture.content, () => {
        execFileSync('mv', [join(harness.repo, 'a'), join(outside, 'a')]);
        symlinkSync(join(outside, 'a'), join(harness.repo, 'a'));
      }),
    });
    assert.equal(failure.reason, 'unstable_capture');
  });
});

describe('failures after publication', () => {
  it('refuses a publication failure and leaves no checkpoint', async () => {
    harness = makeCaptureHarness();
    harness.write('a/b.md', 'b');
    harness.fixture.failNextPut();
    assert.equal((await harness.refusal([dir('a', 'a')])).reason, 'content_publish_failed');
    assert.equal(harness.checkpointCount(), 0);
  });

  it('leaves no visible row when the commit transaction fails, and logs the orphaned references', async () => {
    harness = makeCaptureHarness();
    harness.write('a/b.md', 'b');
    const warn = mock.method(console, 'warn', () => undefined);
    // A transaction that does all its work and then fails, so SQLite genuinely rolls it back.
    const failingCommit = makeWorkflowCheckpointRepository({
      use: harness.fixture.database.use,
      transaction: (operation, execute) =>
        harness.fixture.database.transaction(operation, (db) => {
          execute(db);
          throw new Error('injected failure at the end of the transaction');
        }),
    });
    const exit = await harness.capture([dir('a', 'a')], { checkpoints: failingCommit });
    assert.ok(Exit.isFailure(exit) && exit.cause._tag === 'Fail');
    assert.equal(exit.cause.error._tag, 'DatabaseError');
    assert.equal(harness.checkpointCount(), 0);
    assert.equal(warn.mock.callCount(), 1);
    const [message, detail] = warn.mock.calls[0]!.arguments as [string, Record<string, unknown>];
    assert.match(message, /committed no checkpoint for published content/);
    assert.equal(detail.fault, 'DatabaseError');
    assert.equal(detail.reason, undefined);
    assert.equal((detail.contentRefs as string[]).length, 1);
  });

  it('logs published references when a later stability check refuses', async () => {
    harness = makeCaptureHarness();
    harness.write('a/b.md', 'b');
    const warn = mock.method(console, 'warn', () => undefined);
    await harness.refusal([dir('a', 'a')], {
      content: afterPut(harness.fixture.content, () => harness.write('a/c.md', 'late')),
    });
    assert.equal(warn.mock.callCount(), 1);
    const detail = warn.mock.calls[0]!.arguments[1] as Record<string, unknown>;
    assert.equal(detail.reason, 'unstable_capture');
  });

  it('logs nothing when a refusal happens before any bytes are published', async () => {
    harness = makeCaptureHarness();
    const warn = mock.method(console, 'warn', () => undefined);
    await harness.refusal([dir('typo', 'missing')]);
    assert.equal(warn.mock.callCount(), 0);
  });
});

describe('path identity through directory-entry spelling', () => {
  it('refuses a root named by a case alias', async () => {
    harness = makeCaptureHarness();
    harness.write('docs/a.md', 'a');
    const failure = await harness.refusal([dir('docs', 'Docs')], {
      directoryReader: foldingReader(),
    });
    assert.equal(failure.reason, 'scope_path_spelling_mismatch');
  });

  it('refuses a root named by a Unicode normalization alias', async () => {
    harness = makeCaptureHarness();
    const decomposed = 'café';
    harness.write(`${decomposed}/menu.md`, 'menu');
    const failure = await harness.refusal([dir('cafe', 'café')], {
      directoryReader: foldingReader(),
    });
    assert.equal(failure.reason, 'scope_path_spelling_mismatch');
  });

  it('records a deletion under Git’s spelling when an existing root is spelled otherwise on disk', async () => {
    harness = makeCaptureHarness();
    harness.write('Apps/x.md', 'x');
    harness.write('Apps/y.md', 'y');
    const sha = harness.commitAll('base');
    renameCase('Apps', 'apps');
    harness.remove('apps/x.md');
    harness.remove('apps/y.md');
    harness.write('apps/z.md', 'z');
    const record = await harness.captureOk([dir('apps', 'apps')], {
      directoryReader: foldingReader(),
    });
    assert.equal(record.base.kind === 'git' && record.base.commitSha, sha);
    const stored = rows(record.id);
    assert.deepEqual(stored.files, [['apps/z.md', false]]);
    assert.deepEqual(stored.absences, ['Apps/x.md', 'Apps/y.md']);
  });

  it('refuses a base path respelled onto a saved file', async () => {
    harness = makeCaptureHarness();
    harness.write('Apps/x.md', 'x');
    harness.commitAll('base');
    renameCase('Apps', 'apps');
    const failure = await harness.refusal([dir('apps', 'apps')], {
      directoryReader: foldingReader(),
    });
    assert.equal(failure.reason, 'path_identity_collision');
    assert.equal(failure.path, 'Apps/x.md');
  });

  it('refuses an inherited file that is now a newly saved file under another spelling', async () => {
    harness = makeCaptureHarness();
    harness.write('Notes/n.md', 'n');
    await harness.captureOk([dir('upper', 'Notes')], { directoryReader: foldingReader() });
    renameCase('Notes', 'notes');
    const failure = await harness.refusal([dir('lower', 'notes')], {
      directoryReader: foldingReader(),
    });
    assert.equal(failure.reason, 'path_identity_collision');
    assert.equal(failure.path, 'Notes/n.md');
  });

  it('refuses when hard-linked candidates make an inherited alias undecidable', async () => {
    harness = makeCaptureHarness();
    harness.write('x/A.md', 'a');
    await harness.captureOk([file('upper', 'x/A.md')], { directoryReader: foldingReader() });
    renameCase('x/A.md', 'x/a.md');
    execFileSync('ln', [join(harness.repo, 'x/a.md'), join(harness.repo, 'x/b.md')]);
    const failure = await harness.refusal([file('lower', 'x/a.md')], {
      directoryReader: foldingReader(),
    });
    assert.equal(failure.reason, 'path_identity_collision');
  });

  it('keeps an inherited file whose spelling no longer exists when nothing collides', async () => {
    harness = makeCaptureHarness();
    harness.write('keep/K.md', 'k');
    harness.write('other/o.md', 'o');
    await harness.captureOk([dir('keep', 'keep')]);
    renameCase('keep/K.md', 'keep/k.md');
    const second = await harness.captureOk([dir('other', 'other')], {
      directoryReader: foldingReader(),
    });
    assert.deepEqual(
      rows(second.id).files.map(([path]) => path),
      ['keep/K.md', 'other/o.md'],
    );
  });

  it(
    'refuses a case alias natively on a case-insensitive filesystem',
    { skip: !isCaseInsensitiveHost && 'the host filesystem is case-sensitive' },
    async () => {
      harness = makeCaptureHarness();
      harness.write('docs/a.md', 'a');
      const failure = await harness.refusal([dir('docs', 'DOCS')], {
        directoryReader: nodeDirectoryReader,
      });
      assert.equal(failure.reason, 'scope_path_spelling_mismatch');
    },
  );
});

/** A case-only rename that works on both kinds of filesystem. */
function renameCase(from: string, to: string) {
  const via = `${to}.renaming`;
  execFileSync('mv', [join(harness.repo, from), join(harness.repo, via)]);
  execFileSync('mv', [join(harness.repo, via), join(harness.repo, to)]);
}

/** Runs `mutate` once after the first successful publication, as if the file changed right after streaming. */
function afterPut(
  content: WorkflowContentStoreService,
  mutate: () => void,
): WorkflowContentStoreService {
  let fired = false;
  return {
    ...content,
    put: (input) =>
      content.put(input).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (fired) return;
            fired = true;
            mutate();
          }),
        ),
      ),
  };
}

/** Live Git that runs `mutate` just before the second HEAD read, the stability pass's. */
function commitBeforeSecondHeadRead(mutate: () => void): GitService {
  let headReads = 0;
  return {
    run: (args, options) =>
      Effect.suspend(() => {
        if (args.includes('HEAD^{commit}')) {
          headReads += 1;
          if (headReads === 2) mutate();
        }
        return liveGit.run(args, options);
      }),
  };
}
