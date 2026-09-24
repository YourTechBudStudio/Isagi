import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { NormalizedScope } from './plan.js';
import {
  applyRegions,
  finishFold,
  findScopeIdentityChange,
  type CheckpointEntry,
  type ParentResolvedState,
  type ProvisionalState,
  type Region,
} from './resolve.js';
import type {
  CanonicalBaseEntry,
  CanonicalDirtyEntry,
  CollectedFile,
  CollectedRegion,
  RegionWarning,
} from './types.js';

// Content refs double as Git object ids in these fixtures: identity is all the fold compares.
const ref = (tag: string) => `sha256:${tag.padEnd(64, '0')}`;
const file = (path: string, tag: string, executable = false): CollectedFile => ({
  path,
  contentRef: ref(tag),
  byteSize: tag.length,
  executable,
  objectId: `oid-${tag}`,
});
const baseEntry = (path: string, tag: string, authored = path): CanonicalBaseEntry => ({
  original: path,
  authored,
  objectId: `oid-${tag}`,
  executable: false,
});
const dirty = (path: string, collapsedDirectory = false): CanonicalDirtyEntry => ({
  original: path,
  authored: path,
  collapsedDirectory,
});
const dir = (scopeId: string, path: string, exclusions: string[] = []): NormalizedScope => ({
  scopeId,
  kind: 'directory',
  path,
  exclusions,
});
const single = (scopeId: string, path: string): NormalizedScope => ({
  scopeId,
  kind: 'file',
  path,
  exclusions: [],
});
const region = (
  scope: NormalizedScope,
  files: CollectedFile[],
  warnings: RegionWarning[] = [],
  empty = false,
): CollectedRegion => ({
  scope,
  absoluteRoot: empty ? null : `/wt/${scope.path}`,
  files,
  warnings,
});

interface Layer {
  readonly key: string;
  readonly regions: readonly CollectedRegion[];
  readonly base?: readonly CanonicalBaseEntry[];
  readonly survey?: readonly CanonicalDirtyEntry[] | 'unavailable' | null;
  readonly isGitProject?: boolean;
}

/** Run one layer, returning its rows and the parent state the next layer would read back. */
function fold(parent: ParentResolvedState | null, layer: Layer) {
  const provisional = applyRegions({ checkpointKey: layer.key, parent, regions: layer.regions });
  const survey =
    layer.survey === undefined || layer.survey === null
      ? layer.survey === null
        ? null
        : { ok: true as const, entries: [] }
      : layer.survey === 'unavailable'
        ? { ok: false as const }
        : { ok: true as const, entries: layer.survey };
  const finished = finishFold({
    checkpointKey: layer.key,
    provisional,
    base: layer.base ?? [],
    survey,
    isGitProject: layer.isGitProject ?? true,
  });
  return { ...finished, provisional, next: readBack(provisional) };
}

/** What `resolvedStateOf` reads back from stored rows: files, coverage, region warnings, bindings. */
function readBack(provisional: ProvisionalState): ParentResolvedState {
  return {
    files: provisional.files,
    coverage: provisional.coverage,
    regionWarnings: provisional.regionWarnings,
    bindings: provisional.bindings,
  };
}

const ofKind = <K extends CheckpointEntry['kind']>(entries: readonly CheckpointEntry[], kind: K) =>
  entries.filter((entry): entry is Extract<CheckpointEntry, { kind: K }> => entry.kind === kind);
const filePaths = (entries: readonly CheckpointEntry[]) =>
  ofKind(entries, 'file').map((e) => e.path);
const absentPaths = (entries: readonly CheckpointEntry[]) =>
  ofKind(entries, 'absent').map((e) => e.path);
const changesOf = (entries: readonly CheckpointEntry[]) =>
  ofKind(entries, 'change').map((e) => `${e.operation} ${e.path}`);
const warningsOf = (entries: readonly CheckpointEntry[]) =>
  ofKind(entries, 'warning').map(
    (e) => `${e.reason}${e.path ? ` ${e.path}` : ''} @${e.observedBy}`,
  );
const scopesOf = (entries: readonly CheckpointEntry[]) =>
  ofKind(entries, 'scope').map(
    (e) =>
      `${e.scopeId}:${e.path}${e.exclusions.length ? `-[${e.exclusions}]` : ''} @${e.capturedBy}`,
  );

describe('a first checkpoint', () => {
  it('classifies add, modify, unchanged and an uncommitted deletion against its own base', () => {
    const result = fold(null, {
      key: 'c1',
      regions: [
        region(dir('docs', 'docs'), [
          file('docs/new.md', 'n'),
          file('docs/same.md', 's'),
          file('docs/edited.md', 'e2'),
        ]),
      ],
      base: [
        baseEntry('docs/same.md', 's'),
        baseEntry('docs/edited.md', 'e1'),
        baseEntry('docs/deleted.md', 'd'),
        baseEntry('src/untouched.ts', 'u'),
      ],
    });
    assert.deepEqual(filePaths(result.entries), ['docs/edited.md', 'docs/new.md', 'docs/same.md']);
    assert.deepEqual(absentPaths(result.entries), ['docs/deleted.md']);
    assert.deepEqual(changesOf(result.entries), [
      'delete docs/deleted.md',
      'modify docs/edited.md',
      'add docs/new.md',
    ]);
    assert.deepEqual(result.counts, { scopes: 1, files: 3, absences: 1, warnings: 1 });
    assert.deepEqual(result.kindConflicts, []);
  });

  it('treats a changed executable bit as a modification', () => {
    const result = fold(null, {
      key: 'c1',
      regions: [region(single('run', 'run.sh'), [file('run.sh', 'r', true)])],
      base: [baseEntry('run.sh', 'r')],
    });
    assert.deepEqual(changesOf(result.entries), ['modify run.sh']);
  });

  it('orders rows as scopes, then files and absences by path, then warnings, then changes', () => {
    const result = fold(null, {
      key: 'c1',
      regions: [region(dir('docs', 'docs'), [file('docs/a.md', 'a'), file('docs/c.md', 'c')])],
      base: [baseEntry('docs/b.md', 'b')],
    });
    assert.deepEqual(
      result.entries.map((e) => `${e.kind}${'path' in e && e.path ? ` ${e.path}` : ''}`),
      [
        'scope docs',
        'file docs/a.md',
        'absent docs/b.md',
        'file docs/c.md',
        'warning',
        'change docs/a.md',
        'change docs/b.md',
        'change docs/c.md',
      ],
    );
  });

  it('emits an absence under the base spelling when canonicalization respelled it', () => {
    const result = fold(null, {
      key: 'c1',
      regions: [region(dir('docs', 'docs'), [])],
      base: [baseEntry('docs/Gone.md', 'g', 'docs/gone.md')],
    });
    assert.deepEqual(absentPaths(result.entries), ['docs/Gone.md']);
  });
});

describe('layers', () => {
  const first = fold(null, {
    key: 'c1',
    regions: [
      region(dir('docs', 'docs'), [file('docs/plan.md', 'p1')]),
      region(single('notes', 'notes.md'), [file('notes.md', 'n1')]),
    ],
    base: [baseEntry('docs/plan.md', 'p0')],
  });

  it('an omitted scope inherits prior captured state rather than implying deletion', () => {
    const second = fold(first.next, {
      key: 'c2',
      regions: [region(single('notes', 'notes.md'), [file('notes.md', 'n2')])],
      base: [baseEntry('docs/plan.md', 'p0')],
    });
    assert.deepEqual(filePaths(second.entries), ['docs/plan.md', 'notes.md']);
    assert.deepEqual(absentPaths(second.entries), []);
    assert.deepEqual(changesOf(second.entries), ['modify notes.md']);
    assert.deepEqual(scopesOf(second.entries), ['docs:docs @c1', 'notes:notes.md @c2']);
  });

  it('recomputes absences against its own base when the commit moved', () => {
    // Commit B tracks a file under the inherited `docs` region that commit A did not have.
    const second = fold(first.next, {
      key: 'c2',
      regions: [],
      base: [baseEntry('docs/plan.md', 'p0'), baseEntry('docs/added-on-b.md', 'b')],
    });
    assert.deepEqual(absentPaths(second.entries), ['docs/added-on-b.md']);
    assert.deepEqual(changesOf(second.entries), []);
  });

  it('a created-then-deleted file is absent from the final state, and a required absence if tracked', () => {
    const second = fold(first.next, {
      key: 'c2',
      regions: [region(dir('docs', 'docs'), [])],
      base: [baseEntry('docs/plan.md', 'p0')],
    });
    assert.deepEqual(filePaths(second.entries), ['notes.md']);
    assert.deepEqual(absentPaths(second.entries), ['docs/plan.md']);
    assert.deepEqual(changesOf(second.entries), ['delete docs/plan.md']);
  });

  it('an empty recapture drops inherited files, warns, and turns tracked files into absences', () => {
    const second = fold(first.next, {
      key: 'c2',
      regions: [region(dir('docs', 'docs'), [], [], true)],
      base: [baseEntry('docs/plan.md', 'p0')],
    });
    assert.deepEqual(filePaths(second.entries), ['notes.md']);
    assert.deepEqual(absentPaths(second.entries), ['docs/plan.md']);
    assert.ok(warningsOf(second.entries).includes('scope_recaptured_empty docs @c2'));
  });

  it('a narrower region inside an older wider one replaces only its subregion', () => {
    const wide = fold(null, {
      key: 'c1',
      regions: [region(dir('src', 'src'), [file('src/a.ts', 'a'), file('src/b/old.ts', 'o')])],
    });
    const narrow = fold(wide.next, {
      key: 'c2',
      regions: [region(dir('b', 'src/b'), [file('src/b/new.ts', 'n')])],
    });
    assert.deepEqual(filePaths(narrow.entries), ['src/a.ts', 'src/b/new.ts']);
    assert.deepEqual(scopesOf(narrow.entries), ['src:src @c1', 'b:src/b @c2']);
    assert.deepEqual(changesOf(narrow.entries), ['add src/b/new.ts', 'delete src/b/old.ts']);
  });

  it('a wider region supersedes a narrower one that it fully contains', () => {
    const narrow = fold(null, {
      key: 'c1',
      regions: [region(dir('app', 'src/app'), [file('src/app/x.ts', 'x')])],
    });
    const wide = fold(narrow.next, {
      key: 'c2',
      regions: [region(dir('src', 'src'), [file('src/app/x.ts', 'x2')])],
    });
    assert.deepEqual(scopesOf(wide.entries), ['src:src @c2']);
    assert.deepEqual(filePaths(wide.entries), ['src/app/x.ts']);
  });

  it("another scope's exclusion never masks inherited coverage it only partly contains", () => {
    const app = fold(null, {
      key: 'c1',
      regions: [
        region(dir('app', 'src/app'), [
          file('src/app/main.ts', 'm'),
          file('src/app/gen/out.js', 'g'),
        ]),
      ],
      base: [baseEntry('src/app/gen/tracked.js', 't')],
    });
    const src = fold(app.next, {
      key: 'c2',
      regions: [region(dir('src', 'src', ['app/gen']), [file('src/app/main.ts', 'm2')])],
      base: [baseEntry('src/app/gen/tracked.js', 't')],
    });
    assert.deepEqual(scopesOf(src.entries), ['src:src-[app/gen] @c2', 'app:src/app @c1']);
    assert.deepEqual(filePaths(src.entries), ['src/app/gen/out.js', 'src/app/main.ts']);
    // `app` still covers the generated directory, so its tracked file is still required absent.
    assert.deepEqual(absentPaths(src.entries), ['src/app/gen/tracked.js']);
  });

  it('a region already excluding what the new exclusion removes is fully contained and superseded', () => {
    const app = fold(null, {
      key: 'c1',
      regions: [region(dir('app', 'src/app', ['gen']), [file('src/app/main.ts', 'm')])],
    });
    const src = fold(app.next, {
      key: 'c2',
      regions: [region(dir('src', 'src', ['app/gen/deep']), [file('src/app/main.ts', 'm')])],
    });
    assert.deepEqual(scopesOf(src.entries), ['src:src-[app/gen/deep] @c2']);
  });

  it('a same-id recapture that newly excludes a subpath stops reconstructing it', () => {
    const all = fold(null, {
      key: 'c1',
      regions: [region(dir('src', 'src'), [file('src/a.ts', 'a'), file('src/gen/out.js', 'g')])],
      base: [baseEntry('src/gen/tracked.js', 't')],
    });
    assert.deepEqual(absentPaths(all.entries), ['src/gen/tracked.js']);
    const narrowed = fold(all.next, {
      key: 'c2',
      regions: [region(dir('src', 'src', ['gen']), [file('src/a.ts', 'a')])],
      base: [baseEntry('src/gen/tracked.js', 't')],
    });
    assert.deepEqual(scopesOf(narrowed.entries), ['src:src-[gen] @c2']);
    assert.deepEqual(filePaths(narrowed.entries), ['src/a.ts']);
    // Nothing covers `gen` any more: the baseline wins there, so it is neither a file nor an absence.
    assert.deepEqual(absentPaths(narrowed.entries), []);
  });

  it('never alters an earlier layer: each fold reads only its parent', () => {
    const before = JSON.stringify([...first.next.files.entries()]);
    fold(first.next, { key: 'c2', regions: [region(dir('docs', 'docs'), [])] });
    assert.equal(JSON.stringify([...first.next.files.entries()]), before);
  });
});

describe('skipped entries', () => {
  const symlinkAt = (path: string, scopeId = 'docs'): RegionWarning => ({
    reason: 'symlink_skipped',
    path,
    scopeId,
  });

  it('a base regular file that became a link is neither an absence nor a deletion', () => {
    const result = fold(null, {
      key: 'c1',
      regions: [region(dir('docs', 'docs'), [], [symlinkAt('docs/link.md')])],
      base: [baseEntry('docs/link.md', 'l')],
    });
    assert.deepEqual(absentPaths(result.entries), []);
    assert.deepEqual(changesOf(result.entries), []);
    assert.ok(warningsOf(result.entries).includes('symlink_skipped docs/link.md @c1'));
  });

  it('a skipped link directory protects every base descendant', () => {
    const result = fold(null, {
      key: 'c1',
      regions: [region(dir('docs', 'docs'), [], [symlinkAt('docs/vendor')])],
      base: [baseEntry('docs/vendor/a.md', 'a'), baseEntry('docs/vendor/b/c.md', 'c')],
    });
    assert.deepEqual(absentPaths(result.entries), []);
    assert.deepEqual(changesOf(result.entries), []);
  });

  it('a previously captured file at a now-skipped path is dropped without a deletion', () => {
    const first = fold(null, {
      key: 'c1',
      regions: [region(dir('docs', 'docs'), [file('docs/f.md', 'f')])],
    });
    const second = fold(first.next, {
      key: 'c2',
      regions: [region(dir('docs', 'docs'), [], [symlinkAt('docs/f.md')])],
    });
    assert.deepEqual(filePaths(second.entries), []);
    assert.deepEqual(changesOf(second.entries), []);
  });

  it('region warnings inherit with their region and leave when it is recaptured', () => {
    const first = fold(null, {
      key: 'c1',
      regions: [region(dir('docs', 'docs'), [], [symlinkAt('docs/link')])],
    });
    const omitted = fold(first.next, { key: 'c2', regions: [] });
    assert.deepEqual(warningsOf(omitted.entries), [
      'symlink_skipped docs/link @c1',
      'ignored_paths_not_surveyed @c2',
    ]);
    const recaptured = fold(omitted.next, {
      key: 'c3',
      regions: [region(dir('docs', 'docs'), [])],
    });
    assert.deepEqual(warningsOf(recaptured.entries), ['ignored_paths_not_surveyed @c3']);
  });
});

describe('layer warnings', () => {
  it('reports dirty paths this capture did not itself save, including inherited ones', () => {
    const first = fold(null, {
      key: 'c1',
      regions: [region(dir('docs', 'docs'), [file('docs/draft.md', 'd')])],
    });
    const second = fold(first.next, {
      key: 'c2',
      regions: [region(dir('src', 'src'), [file('src/a.ts', 'a')])],
      base: [baseEntry('src/gone.ts', 'g')],
      survey: [
        dirty('docs/draft.md'),
        dirty('src/a.ts'),
        dirty('src/gone.ts'),
        dirty('build/', true),
      ],
    });
    assert.deepEqual(warningsOf(second.entries), [
      'ignored_paths_not_surveyed @c2',
      'uncaptured_dirty_path build/ @c2',
      'uncaptured_dirty_path docs/draft.md @c2',
    ]);
  });

  it('a folder project has no survey and no ignored-paths limitation', () => {
    const result = fold(null, {
      key: 'c1',
      regions: [region(dir('docs', 'docs'), [])],
      survey: null,
      isGitProject: false,
    });
    assert.deepEqual(warningsOf(result.entries), []);
  });

  it('records an unavailable survey instead of claiming a clean tree', () => {
    const result = fold(null, { key: 'c1', regions: [], survey: 'unavailable' });
    assert.deepEqual(warningsOf(result.entries), [
      'dirty_survey_unavailable @c1',
      'ignored_paths_not_surveyed @c1',
    ]);
  });

  it('caps only uncaptured dirty paths, with one sentinel carrying the omitted count', () => {
    const skipped = Array.from(
      { length: 1200 },
      (_, i): RegionWarning => ({
        reason: 'special_file_skipped',
        path: `docs/fifo-${i}`,
        scopeId: 'docs',
      }),
    );
    const result = fold(null, {
      key: 'c1',
      regions: [region(dir('docs', 'docs'), [], skipped)],
      survey: Array.from({ length: 1005 }, (_, i) => dirty(`elsewhere/${i}.txt`)),
    });
    const warnings = ofKind(result.entries, 'warning');
    const count = (reason: string) => warnings.filter((w) => w.reason === reason).length;
    assert.equal(count('special_file_skipped'), 1200);
    assert.equal(count('uncaptured_dirty_path'), 1000);
    assert.equal(count('ignored_paths_not_surveyed'), 1);
    assert.deepEqual(warnings.find((w) => w.reason === 'warnings_truncated')?.detail, {
      omitted: 5,
    });
    assert.equal(result.counts.warnings, 2202);
  });
});

describe('kind conflicts', () => {
  it('refuses a final state that needs one path as both a file and a directory', () => {
    const result = fold(null, {
      key: 'c1',
      regions: [region(dir('docs', 'docs'), [file('docs/guide', 'g')])],
      base: [baseEntry('docs/guide/intro.md', 'i')],
    });
    assert.deepEqual(result.kindConflicts, [['docs/guide', 'docs/guide/intro.md']]);
  });

  it('refuses a file scope beside an older directory scope at the same path under another id', () => {
    const first = fold(null, { key: 'c1', regions: [region(dir('guide', 'docs/guide'), [])] });
    const second = fold(first.next, {
      key: 'c2',
      regions: [region(single('guide-file', 'docs/guide'), [file('docs/guide', 'g')])],
    });
    assert.deepEqual(scopesOf(second.entries), [
      'guide:docs/guide @c1',
      'guide-file:docs/guide @c2',
    ]);
    assert.deepEqual(second.kindConflicts, [['docs/guide', 'docs/guide']]);
  });

  it('refuses the contradiction even when neither region holds a file row', () => {
    const first = fold(null, { key: 'c1', regions: [region(dir('guide', 'docs/guide'), [])] });
    const second = fold(first.next, {
      key: 'c2',
      regions: [region(single('guide-file', 'docs/guide'), [], [], true)],
    });
    assert.deepEqual(second.kindConflicts, [['docs/guide', 'docs/guide']]);
  });

  it('refuses a directory region beneath a file region', () => {
    const first = fold(null, { key: 'c1', regions: [region(single('cfg', 'config'), [])] });
    const second = fold(first.next, { key: 'c2', regions: [region(dir('sub', 'config/sub'), [])] });
    assert.deepEqual(second.kindConflicts, [['config', 'config/sub']]);
  });
});

describe('scope identity', () => {
  it('rejects a repeated id whose root or kind changed and allows changed exclusions', () => {
    const bindings = new Map([
      ['src', { scopeId: 'src', kind: 'directory' as const, path: 'src', exclusions: [] }],
    ]);
    assert.equal(findScopeIdentityChange(bindings, [dir('src', 'src', ['gen'])]), null);
    assert.equal(findScopeIdentityChange(bindings, [dir('other', 'lib')]), null);
    assert.equal(findScopeIdentityChange(bindings, [dir('src', 'lib')])?.previous.path, 'src');
    assert.equal(
      findScopeIdentityChange(bindings, [single('src', 'src')])?.previous.kind,
      'directory',
    );
  });

  it('keeps the latest binding of an id even after its region was superseded', () => {
    const narrow = fold(null, { key: 'c1', regions: [region(dir('app', 'src/app'), [])] });
    const wide = fold(narrow.next, { key: 'c2', regions: [region(dir('src', 'src'), [])] });
    assert.deepEqual(
      wide.next.coverage.map((r: Region) => r.scopeId),
      ['src'],
    );
    assert.equal(wide.next.bindings.get('app')?.path, 'src/app');
  });
});
