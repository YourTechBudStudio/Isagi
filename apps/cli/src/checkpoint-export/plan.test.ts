import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkflowCheckpointInventoryEntry } from '@isagi/contracts';

import { planExport, unsafePathRule } from './plan.js';

const file = (path: string): WorkflowCheckpointInventoryEntry => ({
  kind: 'file',
  path,
  fileId: `wcf_${path}`,
  sha256: '0'.repeat(64),
  sizeBytes: 0,
  executable: false,
});
const absent = (path: string): WorkflowCheckpointInventoryEntry => ({ kind: 'absent', path });

function problemOf(entries: readonly WorkflowCheckpointInventoryEntry[]) {
  const outcome = planExport(entries);
  assert.equal(outcome.ok, false, 'expected the inventory to be refused');
  return outcome.ok ? undefined : outcome.problem;
}

test('a safe path is relative, non-empty, NUL-free, with no empty, dot or .git segment', () => {
  assert.equal(unsafePathRule('src/a.ts'), null);
  assert.equal(unsafePathRule('.github/workflows/ci.yml'), null);
  assert.equal(unsafePathRule('a/.gitignore'), null);
  assert.equal(unsafePathRule(''), 'empty');
  assert.equal(unsafePathRule('a\0b'), 'nul');
  assert.equal(unsafePathRule('/etc/passwd'), 'absolute');
  assert.equal(unsafePathRule('a//b'), 'bad_segment');
  assert.equal(unsafePathRule('a/'), 'bad_segment');
  assert.equal(unsafePathRule('./a'), 'bad_segment');
  assert.equal(unsafePathRule('a/../../b'), 'bad_segment');
  assert.equal(unsafePathRule('.git/config'), 'git_directory');
  assert.equal(unsafePathRule('sub/.GIT/hooks/post-checkout'), 'git_directory');
});

test('unsafe file and absence paths are refused', () => {
  assert.deepEqual(problemOf([file('../escape')]), {
    kind: 'unsafe_path',
    path: '../escape',
    rule: 'bad_segment',
  });
  assert.deepEqual(problemOf([absent('.git')]), {
    kind: 'unsafe_path',
    path: '.git',
    rule: 'git_directory',
  });
});

test('duplicates, file-and-absence and file-as-directory are conflicts', () => {
  assert.deepEqual(problemOf([file('a'), file('a')]), { kind: 'duplicate_file', path: 'a' });
  assert.deepEqual(problemOf([file('a'), absent('a')]), { kind: 'file_and_absence', path: 'a' });
  assert.deepEqual(problemOf([file('a/b'), file('a')]), {
    kind: 'file_is_directory_prefix',
    path: 'a',
    other: 'a/b',
  });
});

test('R6: file targets that fold together are refused, including as a directory prefix', () => {
  assert.deepEqual(problemOf([file('README.md'), file('readme.md')]), {
    kind: 'folding_collision',
    path: 'readme.md',
    other: 'README.md',
  });
  // "é" precomposed and decomposed.
  assert.equal(problemOf([file('café'), file('café')])?.kind, 'folding_collision');
  assert.deepEqual(problemOf([file('Docs'), file('docs/a.md')]), {
    kind: 'folding_collision',
    path: 'Docs',
    other: 'docs/a.md',
  });
});

test('an absence that folds onto a file is allowed, because absences apply first', () => {
  const outcome = planExport([absent('README.md'), file('readme.md')]);
  assert.equal(outcome.ok, true);
});

test('scopes and warnings are carried and never become files or absences', () => {
  const outcome = planExport([
    {
      kind: 'scope',
      scopeId: 's1',
      scopeKind: 'directory',
      path: 'src',
      exclusions: [],
      capturedBy: 'wcp_1',
    },
    file('src/a.ts'),
    absent('src/b.ts'),
    {
      kind: 'warning',
      reason: 'symlink_skipped',
      path: 'src/link',
      scopeId: 's1',
      detail: null,
      observedBy: 'wcp_1',
    },
  ]);
  assert.ok(outcome.ok);
  assert.deepEqual(
    outcome.plan.files.map((entry) => entry.path),
    ['src/a.ts'],
  );
  assert.deepEqual(
    outcome.plan.absences.map((entry) => entry.path),
    ['src/b.ts'],
  );
  assert.equal(outcome.plan.scopes.length, 1);
  assert.equal(outcome.plan.warnings.length, 1);
});
