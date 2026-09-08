import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test, { type TestContext } from 'node:test';

import { Effect, Fiber } from 'effect';

import {
  selectDirectorySuggestions,
  suggestPaths,
  suggestPathsAtHome,
  type ScanDirent,
} from './path.suggestions.js';

// The explicit-home tests inject their own isolated temp home. The one public-wrapper
// smoke test calls `suggestPaths`, which reads the real runtime home through
// `homedir()` -- it reads, and nothing here writes. That distinction is the point: the
// runtime suite runs with `--experimental-test-isolation=none`, so mutating the
// environment would be a cross-test hazard rather than a local one.
function tempDir(t: TestContext, prefix: string) {
  const path = mkdtempSync(join(tmpdir(), `isagi-paths-${prefix}-`));
  t.after(() => {
    rmSync(path, { recursive: true, force: true });
  });
  return path;
}

type DirentKind = 'directory' | 'file' | 'symlink' | 'unknown';

function dirent(name: string, kind: DirentKind = 'directory'): ScanDirent {
  return {
    name,
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'symlink',
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

// Independently constructed expectation: the stable name-sort the bounded buffer must
// reproduce. Built with `Array.prototype.sort` and an explicit index tiebreak rather
// than by reusing anything from the implementation.
function expectedSelection(
  entries: readonly ScanDirent[],
  isDirectory: (entry: ScanDirent) => boolean,
  filter: string,
  limit: number,
) {
  const showHidden = filter.startsWith('.');
  const lower = filter.toLowerCase();
  const collator = new Intl.Collator(undefined, { usage: 'sort' });
  return entries
    .map((entry, order) => ({ entry, order }))
    .filter(({ entry }) => showHidden || !entry.name.startsWith('.'))
    .filter(({ entry }) => entry.name.toLowerCase().startsWith(lower))
    .filter(({ entry }) => isDirectory(entry))
    .sort((a, b) => collator.compare(a.entry.name, b.entry.name) || a.order - b.order)
    .slice(0, limit)
    .map(({ entry }) => entry.name);
}

function labels(output: { readonly suggestions: readonly { readonly label: string }[] }) {
  return output.suggestions.map((suggestion) => suggestion.label);
}

function isOutside(path: string, home: string) {
  return path !== home && !path.startsWith(`${home}${sep}`);
}

const nextTurn = () => new Promise<void>((resolve) => void setImmediate(resolve));

// --- Directory scope and matching -------------------------------------------------

test('a partial path outside the runtime home yields its matching subdirectories', async (t) => {
  const home = tempDir(t, 'home');
  const root = tempDir(t, 'root');
  assert.ok(isOutside(root, home), 'the fixture must actually sit outside the injected home');

  for (const name of ['project-alpha', 'project-beta', 'notes']) mkdirSync(join(root, name));
  writeFileSync(join(root, 'project-file'), '');

  const output = await Effect.runPromise(
    suggestPathsAtHome({ input: join(root, 'project') }, home),
  );

  assert.deepEqual(labels(output), ['project-alpha', 'project-beta']);
  assert.deepEqual(
    output.suggestions.map((suggestion) => suggestion.path),
    [join(root, 'project-alpha'), join(root, 'project-beta')],
  );
  assert.equal(output.basePath, root);
  assert.equal(output.input, join(root, 'project'));
  assert.ok(output.suggestions.every((suggestion) => suggestion.kind === 'directory'));
});

test('prefix matching is case-insensitive', async (t) => {
  const home = tempDir(t, 'home');
  const root = tempDir(t, 'root');
  for (const name of ['Alpha', 'alphabet', 'beta']) mkdirSync(join(root, name));

  const output = await Effect.runPromise(suggestPathsAtHome({ input: join(root, 'aLpH') }, home));
  assert.deepEqual(labels(output), ['Alpha', 'alphabet']);
});

test('hidden directories appear only when the filter itself starts with a dot', async (t) => {
  const home = tempDir(t, 'home');
  const root = tempDir(t, 'root');
  for (const name of ['.hidden', '.hidden-two', 'visible']) mkdirSync(join(root, name));

  const withoutDot = await Effect.runPromise(suggestPathsAtHome({ input: `${root}${sep}` }, home));
  assert.deepEqual(labels(withoutDot), ['visible']);

  const withDot = await Effect.runPromise(suggestPathsAtHome({ input: join(root, '.h') }, home));
  assert.deepEqual(labels(withDot), ['.hidden', '.hidden-two']);
  assert.ok(withDot.suggestions.every((suggestion) => suggestion.hidden));
});

test('a trailing separator lists the children of that directory', async (t) => {
  const home = tempDir(t, 'home');
  const root = tempDir(t, 'root');
  const parent = join(root, 'parent');
  mkdirSync(parent);
  for (const name of ['child-a', 'child-b']) mkdirSync(join(parent, name));

  const output = await Effect.runPromise(suggestPathsAtHome({ input: `${parent}${sep}` }, home));
  assert.equal(output.basePath, parent);
  assert.deepEqual(labels(output), ['child-a', 'child-b']);
});

test('results honour the default limit, an explicit limit, and stable name order', async (t) => {
  const home = tempDir(t, 'home');
  const root = tempDir(t, 'root');
  const names = Array.from({ length: 40 }, (_, index) => `dir-${String(index).padStart(3, '0')}`);
  for (const name of [...names].reverse()) mkdirSync(join(root, name));

  const byDefault = await Effect.runPromise(suggestPathsAtHome({ input: join(root, 'dir') }, home));
  assert.deepEqual(labels(byDefault), names.slice(0, 25));

  const explicit = await Effect.runPromise(
    suggestPathsAtHome({ input: join(root, 'dir'), limit: 3 }, home),
  );
  assert.deepEqual(labels(explicit), names.slice(0, 3));
});

test('directory symlinks are suggested, including targets outside the home, and file or broken symlinks are not', async (t) => {
  const home = tempDir(t, 'home');
  const root = tempDir(t, 'root');
  const target = tempDir(t, 'target');
  assert.ok(isOutside(target, home), 'the symlink target must sit outside the injected home');

  symlinkSync(target, join(root, 'link-directory'));
  writeFileSync(join(root, 'plain-file'), '');
  symlinkSync(join(root, 'plain-file'), join(root, 'link-file'));
  symlinkSync(join(root, 'does-not-exist'), join(root, 'link-broken'));

  const output = await Effect.runPromise(suggestPathsAtHome({ input: join(root, 'link') }, home));
  assert.deepEqual(labels(output), ['link-directory']);
});

// --- Advisory failure policy ------------------------------------------------------

test('a missing base is a successful empty listing', async (t) => {
  const home = tempDir(t, 'home');
  const root = tempDir(t, 'root');
  const missing = join(root, 'nowhere');

  const output = await Effect.runPromise(suggestPathsAtHome({ input: `${missing}${sep}` }, home));
  assert.deepEqual(output.suggestions, []);
  assert.equal(output.basePath, missing);
});

test('a non-directory base is a successful empty listing', async (t) => {
  const home = tempDir(t, 'home');
  const root = tempDir(t, 'root');
  const file = join(root, 'a-file');
  writeFileSync(file, '');

  const output = await Effect.runPromise(suggestPathsAtHome({ input: `${file}${sep}` }, home));
  assert.deepEqual(output.suggestions, []);
});

test('an unreadable base is a successful empty listing', async (t) => {
  const home = tempDir(t, 'home');
  const root = tempDir(t, 'root');
  const locked = join(root, 'locked');
  mkdirSync(locked);
  mkdirSync(join(locked, 'child'));

  chmodSync(locked, 0o000);
  try {
    // Confirm the fixture actually produces the permission failure before asserting
    // the advisory outcome. A root or otherwise privileged account bypasses the mode
    // bits, and an ENOENT case must never be substituted for a skipped EACCES check.
    let code: string | undefined;
    try {
      readdirSync(locked);
    } catch (error) {
      code = (error as NodeJS.ErrnoException).code;
    }
    if (code !== 'EACCES') {
      t.skip(`this account reads a 0o000 directory (readdir code: ${code ?? 'none'})`);
      return;
    }

    const output = await Effect.runPromise(suggestPathsAtHome({ input: `${locked}${sep}` }, home));
    assert.deepEqual(output.suggestions, []);
    assert.equal(output.basePath, locked);
  } finally {
    chmodSync(locked, 0o700);
  }
});

// --- Home interpretation and display spelling -------------------------------------

test('empty input lists the injected home and displays it as a tilde', async (t) => {
  const home = tempDir(t, 'home');
  for (const name of ['work', 'notes']) mkdirSync(join(home, name));

  const output = await Effect.runPromise(suggestPathsAtHome({ input: '   ' }, home));
  assert.equal(output.basePath, '~');
  assert.deepEqual(labels(output), ['notes', 'work']);
  assert.deepEqual(
    output.suggestions.map((suggestion) => suggestion.path),
    ['~/notes', '~/work'],
  );
});

test('relative suggestion input resolves against the runtime home, not the cwd', async (t) => {
  const home = tempDir(t, 'home');
  mkdirSync(join(home, 'work'));
  mkdirSync(join(home, 'work', 'projects'));

  const output = await Effect.runPromise(suggestPathsAtHome({ input: 'work/pro' }, home));
  assert.equal(output.basePath, '~/work');
  assert.deepEqual(labels(output), ['projects']);
});

test('tilde input expands against the injected home', async (t) => {
  const home = tempDir(t, 'home');
  mkdirSync(join(home, 'work'));
  mkdirSync(join(home, 'work', 'isagi'));

  const output = await Effect.runPromise(suggestPathsAtHome({ input: '~/work/is' }, home));
  assert.deepEqual(
    output.suggestions.map((suggestion) => suggestion.path),
    ['~/work/isagi'],
  );
});

test('paths outside the home keep their absolute spelling', async (t) => {
  const home = tempDir(t, 'home');
  const root = tempDir(t, 'root');
  mkdirSync(join(root, 'repos'));

  const output = await Effect.runPromise(suggestPathsAtHome({ input: join(root, 're') }, home));
  assert.deepEqual(
    output.suggestions.map((suggestion) => suggestion.path),
    [join(root, 'repos')],
  );
  assert.ok(!output.suggestions[0]!.path.startsWith('~'));
});

test('the public entry point delegates to the explicit-home implementation on each execution', async () => {
  // `Effect.suspend` means home is read when the effect executes. Executing the same
  // effect value twice must therefore work and agree. That home is process-global is
  // why this pins re-execution rather than a changed home.
  const effect = suggestPaths({ input: '', limit: 1 });
  const first = await Effect.runPromise(effect);
  const second = await Effect.runPromise(effect);
  assert.equal(first.basePath, '~');
  assert.equal(second.basePath, first.basePath);
});

// --- Selection exactness ----------------------------------------------------------

test('candidates whose resolution fails cannot consume slots reserved for confirmed directories', async (t) => {
  const root = tempDir(t, 'select');
  // 200 failed-resolution candidates: symlink dirents naming paths that do not exist,
  // so each costs a real `stat` that fails and none is ever confirmed. They sort
  // ahead of the 30 real directories, which is the arrangement that would produce a
  // short answer if unconfirmed entries could occupy the buffer.
  const unresolvable = Array.from({ length: 200 }, (_, index) =>
    dirent(`dir-aaa-${String(index).padStart(3, '0')}`, 'symlink'),
  );
  const confirmed = Array.from({ length: 30 }, (_, index) =>
    dirent(`dir-zzz-${String(index).padStart(3, '0')}`, 'directory'),
  );
  const entries = [...unresolvable, ...confirmed];

  const selected = await Effect.runPromise(selectDirectorySuggestions(root, entries, 'dir', 25));
  assert.equal(selected.length, 25);
  assert.deepEqual(
    selected.map((candidate) => candidate.name),
    expectedSelection(entries, (entry) => entry.isDirectory(), 'dir', 25),
  );
});

test('matching entries spanning several chunks return the same list as the stable-sort oracle', async (t) => {
  const root = tempDir(t, 'select');
  // Descending names across 2500 entries: every candidate beats the current buffer, so
  // insertions keep happening past each 1000-entry chunk boundary.
  const entries = Array.from({ length: 2_500 }, (_, index) =>
    dirent(`dir-${String(2_499 - index).padStart(4, '0')}`),
  );

  const selected = await Effect.runPromise(selectDirectorySuggestions(root, entries, 'dir', 25));
  assert.deepEqual(
    selected.map((candidate) => candidate.name),
    expectedSelection(entries, (entry) => entry.isDirectory(), 'dir', 25),
  );
});

test('a deferred resolution lands in sort order, not in the order it reached the buffer', async (t) => {
  const root = tempDir(t, 'select');
  mkdirSync(join(root, 'dir-aaa'));
  // `dir-aaa` is enumerated second and needs resolution, so it reaches the buffer
  // after the directly-confirmed `dir-bbb`. It must still sort first. This pins
  // placement against insertion order; it does not pin the completion order of
  // concurrent `stat` calls, which nothing here controls.
  const entries = [dirent('dir-bbb', 'directory'), dirent('dir-aaa', 'symlink')];

  const selected = await Effect.runPromise(selectDirectorySuggestions(root, entries, 'dir', 25));
  assert.deepEqual(
    selected.map((candidate) => candidate.name),
    ['dir-aaa', 'dir-bbb'],
  );
});

test('equal-collating names keep enumeration order even when one needs deferred resolution', async (t) => {
  const precomposed = '\u00e9clair';
  const decomposed = 'e\u0301clair';
  const collator = new Intl.Collator(undefined, { usage: 'sort' });
  if (collator.compare(precomposed, decomposed) !== 0) {
    t.skip('this ICU build does not collate the two spellings equal');
    return;
  }

  const root = tempDir(t, 'select');
  mkdirSync(join(root, decomposed));
  try {
    statSync(join(root, decomposed));
  } catch {
    t.skip('this filesystem does not preserve the decomposed spelling for lookup');
    return;
  }

  // The precomposed entry is dirent-confirmed and inserted directly; the decomposed
  // one is resolved afterwards. Only the enumeration-index tiebreak keeps them in
  // enumeration order once resolution reorders arrival.
  const entries = [dirent(precomposed, 'directory'), dirent(decomposed, 'symlink')];
  const selected = await Effect.runPromise(selectDirectorySuggestions(root, entries, '', 25));
  assert.deepEqual(
    selected.map((candidate) => candidate.name),
    [precomposed, decomposed],
  );

  const reversed = [dirent(decomposed, 'symlink'), dirent(precomposed, 'directory')];
  const reversedSelected = await Effect.runPromise(
    selectDirectorySuggestions(root, reversed, '', 25),
  );
  assert.deepEqual(
    reversedSelected.map((candidate) => candidate.name),
    [decomposed, precomposed],
  );
});

test('unknown-type dirents are resolved and confirmed by their real type', async (t) => {
  const root = tempDir(t, 'select');
  mkdirSync(join(root, 'dir-unknown'));
  writeFileSync(join(root, 'dir-plain'), '');
  const entries = [dirent('dir-unknown', 'unknown'), dirent('dir-plain', 'unknown')];

  const selected = await Effect.runPromise(selectDirectorySuggestions(root, entries, 'dir', 25));
  assert.deepEqual(
    selected.map((candidate) => candidate.name),
    ['dir-unknown'],
  );
});

test('a known non-directory dirent is not confirmed even when its name is a real directory', async (t) => {
  const root = tempDir(t, 'select');
  // The name exists on disk as a real directory, so an implementation that resolved
  // dirents already reporting their type would confirm and return it. Its absence
  // shows resolution is not consulted for such an entry. That no `stat` syscall is
  // issued at all is the stronger claim, and rests on code inspection: a resolution
  // that were issued and then discarded would pass this test too.
  mkdirSync(join(root, 'dir-real'));
  const selected = await Effect.runPromise(
    selectDirectorySuggestions(root, [dirent('dir-real', 'file')], 'dir', 25),
  );
  assert.deepEqual(selected, []);
});

// --- Event-loop responsiveness ----------------------------------------------------

test('the listing effect cannot be run synchronously', async (t) => {
  const home = tempDir(t, 'home');
  const root = tempDir(t, 'root');
  mkdirSync(join(root, 'child'));

  assert.throws(() => Effect.runSync(suggestPathsAtHome({ input: `${root}${sep}` }, home)));
});

test('an unrelated read completes while a filesystem-bound listing is still pending', async (t) => {
  const home = tempDir(t, 'home');
  const root = tempDir(t, 'root');
  const marker = join(root, 'marker.txt');
  const scan = join(root, 'scan');
  mkdirSync(scan);
  // 2000 candidates that all need resolution and none of which ever confirms, so the
  // buffer never fills and none is pruned: the listing spends ~250 sequential rounds
  // of concurrency-8 `stat` calls. Pendency is asserted, not assumed.
  for (let index = 0; index < 2_000; index += 1) {
    symlinkSync(join(root, 'missing-target'), join(scan, `link-${String(index).padStart(4, '0')}`));
  }
  writeFileSync(marker, 'ready');

  let listingSettled = false;
  const listing = Effect.runPromise(suggestPathsAtHome({ input: `${scan}${sep}` }, home)).then(
    (output) => {
      listingSettled = true;
      return output;
    },
  );

  try {
    assert.equal(await readFile(marker, 'utf8'), 'ready');
    assert.equal(listingSettled, false, 'the listing must still be pending when the read resolves');
  } finally {
    // Settle the scan before this test's directory cleanup runs, on every exit path.
    // A failing assertion must not leave ~2000 pending `stat` calls running against a
    // directory the `after` hook is about to delete: the suite shares one process, so
    // that work would land in later tests. `never` in the error channel rules out
    // typed failures, not defects or interruption, so this await can itself reject --
    // which is a test failure, deliberately not swallowed.
    await listing;
  }

  // Safe to await again: a settled promise retains its settlement.
  const output = await listing;
  assert.deepEqual(output.suggestions, []);
});

test('selection yields real event-loop turns between bounded slices', async (t) => {
  const root = tempDir(t, 'select');
  // Every entry is dirent-confirmed, so zero `stat` calls occur and every counted turn
  // is a processing yield rather than time spent waiting on the filesystem.
  const entries = Array.from({ length: 10_000 }, (_, index) =>
    dirent(`dir-${String(9_999 - index).padStart(5, '0')}`),
  );

  let turns = 0;
  let observing = true;
  const tick = () => {
    if (!observing) return;
    turns += 1;
    setImmediate(tick);
  };
  setImmediate(tick);

  try {
    const selected = await Effect.runPromise(selectDirectorySuggestions(root, entries, 'dir', 25));
    assert.equal(selected.length, 25);
  } finally {
    observing = false;
  }

  assert.ok(turns >= 5, `expected at least five processing turns between slices, saw ${turns}`);
});

test('interrupting a large selection stops further processing instead of leaking scheduled work', async (t) => {
  const root = tempDir(t, 'select');
  let examined = 0;
  // Descending names keep every candidate ahead of the buffer, so `isDirectory` is
  // consulted for each one and the counter tracks real progress through the scan.
  const entries: ScanDirent[] = Array.from({ length: 50_000 }, (_, index) => ({
    name: `dir-${String(49_999 - index).padStart(5, '0')}`,
    isDirectory: () => {
      examined += 1;
      return true;
    },
    isFile: () => false,
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  }));

  const fiber = Effect.runFork(selectDirectorySuggestions(root, entries, 'dir', 25));
  let atInterrupt = 0;
  try {
    await nextTurn();
    await nextTurn();
    const midway = examined;
    assert.ok(midway > 0, 'the scan should have started');
    assert.ok(midway < entries.length, 'the scan should not have completed within two turns');
  } finally {
    // Every exit path reaches the interrupt, so a failing midway assertion cannot
    // leave a live 50,000-entry fiber running into the rest of the shared-process
    // suite. Interrupting an already-completed fiber is a no-op.
    await Effect.runPromise(Fiber.interrupt(fiber));
    atInterrupt = examined;
  }

  await nextTurn();
  await nextTurn();
  await nextTurn();

  assert.equal(examined, atInterrupt, 'no further chunk ran after interruption');
  assert.ok(atInterrupt < entries.length, 'the scan was interrupted before completing');
});
