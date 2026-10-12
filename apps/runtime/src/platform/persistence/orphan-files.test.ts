import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import { makeLogCapture } from '../../../test/test-support.js';
import {
  isIdName,
  lastWriteMs,
  listOrphanCandidates,
  openCollectorRoot,
  sweepOrphans,
  type GuardedDirectory,
  type OrphanCandidate,
  type OrphanListing,
} from './orphan-files.js';

const minAgeMs = 60_000;
const nowMs = Date.parse('2026-10-08T12:00:00.000Z');
const oldDate = new Date(nowMs - 2 * minAgeMs);

test('isIdName accepts only canonical positive integers', () => {
  assert.equal(isIdName('7'), true);
  for (const name of ['01', '0', '1e3', '-1', '1.5', '', ' 7', 'abc', '9007199254740993']) {
    assert.equal(isIdName(name), false, name);
  }
});

test('lastWriteMs reflects a newer direct child', () => {
  withDataRoot((dataRoot) => {
    const folder = join(dataRoot, 'folder');
    mkdirSync(folder);
    writeFileSync(join(folder, 'child'), 'x');
    utimesSync(folder, oldDate, oldDate);
    const childDate = new Date(nowMs - 1_000);
    utimesSync(join(folder, 'child'), childDate, childDate);

    assert.equal(lastWriteMs(folder), childDate.getTime());
  });
});

test('openCollectorRoot reports absent, unusable and ready roots', async () => {
  await withDataRootAsync(async (dataRoot) => {
    const logs = makeLogCapture();
    const open = (segments: readonly string[]) =>
      Effect.runPromise(
        Effect.scoped(
          openCollectorRoot(dataRoot, segments, 'test').pipe(Effect.provide(logs.layer)),
        ),
      );
    assert.deepEqual(await open(['a', 'b']), { status: 'absent' });
    assert.equal(logs.lines.length, 0, 'an absent root is not worth a log line');

    mkdirSync(join(dataRoot, 'a', 'b'), { recursive: true });
    const ready = await open(['a', 'b']);
    assert.equal(ready.status, 'ready');
    if (ready.status === 'ready') {
      assert.deepEqual(ready.directory.guards, [join(dataRoot, 'a'), join(dataRoot, 'a', 'b')]);
    }

    const elsewhere = mkdtempSync(join(tmpdir(), 'isagi-orphan-files-elsewhere-'));
    try {
      symlinkSync(elsewhere, join(dataRoot, 'linked'));
      assert.deepEqual(await open(['linked']), { status: 'unusable' });
      writeFileSync(join(dataRoot, 'file'), 'x');
      assert.deepEqual(await open(['file']), { status: 'unusable' });
      assert.deepEqual(
        logs.lines.map((line) => [line.level, line.message, line.annotations]),
        [
          [
            'Warn',
            'Skipping orphan collection: not a real directory',
            { collector: 'test', path: join(dataRoot, 'linked') },
          ],
          [
            'Warn',
            'Skipping orphan collection: not a real directory',
            { collector: 'test', path: join(dataRoot, 'file') },
          ],
        ],
      );
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

test('listOrphanCandidates lists only real entries of the requested kind with accepted names', async () => {
  await withDataRootAsync(async (dataRoot) => {
    const root = await guardedRoot(dataRoot, 'root');
    mkdirSync(join(root.path, '1'));
    mkdirSync(join(root.path, 'notes'));
    writeFileSync(join(root.path, '2'), 'x');
    symlinkSync(join(root.path, '1'), join(root.path, '3'));

    const directories = await list(root, 'directory');
    const files = await list(root, 'file');

    assert.deepEqual(names(directories), ['1']);
    assert.deepEqual(names(files), ['2']);
  });
});

test('sweepOrphans removes old unreferenced files and directories by kind', async () => {
  await withDataRootAsync(async (dataRoot) => {
    const root = await guardedRoot(dataRoot, 'root');
    mkdirSync(join(root.path, '1'));
    writeFileSync(join(root.path, '1', 'nested'), 'x');
    writeFileSync(join(root.path, '2'), 'x');
    mkdirSync(join(root.path, '3'));
    mkdirSync(join(root.path, '4'));
    for (const name of ['1/nested', '1', '2', '3']) {
      utimesSync(join(root.path, name), oldDate, oldDate);
    }

    const logs = makeLogCapture();
    const stats = await sweep(
      {
        label: 'test entry',
        candidates: [...listed(await list(root, 'directory')), ...listed(await list(root, 'file'))],
        isLive: (candidate) => candidate.name === '3',
        minAgeMs,
        nowMs,
      },
      logs,
    );

    assert.deepEqual([...stats.deleted].sort(), ['1', '2']);
    assert.equal(stats.kept, 1);
    assert.deepEqual(stats.skippedYoung, ['4']);
    assert.equal(existsSync(join(root.path, '1')), false);
    assert.equal(existsSync(join(root.path, '2')), false);
    assert.equal(existsSync(join(root.path, '3')), true);
    assert.equal(existsSync(join(root.path, '4')), true);
    assert.deepEqual(
      logs.lines.map((line) => [line.level, line.message, line.annotations]),
      [['Info', 'Deleted orphan entries', { collector: 'test entry', count: 2, sample: '1, 2' }]],
    );
  });
});

test('sweepOrphans ignores entries that vanished and skips entries of the wrong type', async () => {
  await withDataRootAsync(async (dataRoot) => {
    const root = await guardedRoot(dataRoot, 'root');
    mkdirSync(join(root.path, '1'));
    mkdirSync(join(root.path, '2'));
    const candidates = listed(await list(root, 'directory'));
    rmSync(join(root.path, '1'), { recursive: true });
    rmSync(join(root.path, '2'), { recursive: true });
    writeFileSync(join(root.path, '2'), 'x');
    utimesSync(join(root.path, '2'), oldDate, oldDate);

    const stats = await sweep({
      label: 'test entry',
      candidates,
      isLive: () => false,
      minAgeMs,
      nowMs,
    });

    assert.deepEqual(stats.deleted, []);
    assert.deepEqual(stats.failed, []);
    assert.deepEqual(stats.skippedUnsafe, ['2']);
    assert.equal(existsSync(join(root.path, '2')), true);
  });
});

test('sweepOrphans skips candidates whose guard became a symlink after listing', async () => {
  await withDataRootAsync(async (dataRoot) => {
    const shard = await guardedRoot(dataRoot, 'root', 'shard');
    writeFileSync(join(shard.path, '1'), 'x');
    const candidates = listed(await list(shard, 'file'));

    const decoy = mkdtempSync(join(tmpdir(), 'isagi-orphan-files-decoy-'));
    try {
      writeFileSync(join(decoy, '1'), 'decoy');
      utimesSync(join(decoy, '1'), oldDate, oldDate);
      renameSync(shard.path, join(dataRoot, 'root', 'moved'));
      symlinkSync(decoy, shard.path);

      const stats = await sweep({
        label: 'test entry',
        candidates,
        isLive: () => false,
        minAgeMs,
        nowMs,
      });

      assert.deepEqual(stats.skippedUnsafe, ['1']);
      assert.equal(existsSync(join(decoy, '1')), true);
    } finally {
      rmSync(decoy, { recursive: true, force: true });
    }
  });
});

test('sweepOrphans turns a throw into a failed entry and still resolves', async () => {
  await withDataRootAsync(async (dataRoot) => {
    const root = await guardedRoot(dataRoot, 'root');
    writeFileSync(join(root.path, '1'), 'x');
    writeFileSync(join(root.path, '2'), 'x');
    utimesSync(join(root.path, '1'), oldDate, oldDate);
    utimesSync(join(root.path, '2'), oldDate, oldDate);

    const logs = makeLogCapture();
    const stats = await sweep(
      {
        label: 'test entry',
        candidates: listed(await list(root, 'file')),
        isLive: (candidate) => {
          if (candidate.name === '1') throw new Error('mark unavailable');
          return false;
        },
        minAgeMs,
        nowMs,
      },
      logs,
    );

    assert.deepEqual(stats.failed, ['1']);
    assert.deepEqual(stats.deleted, ['2']);
    assert.equal(existsSync(join(root.path, '1')), true);
    // The cause is rendered by the redaction rule: the class name, never the error's own text.
    assert.deepEqual(
      logs.lines.map((line) => [line.level, line.message, line.annotations]),
      [
        [
          'Warn',
          'Could not clean an orphan entry',
          { collector: 'test entry', name: '1', cause: 'Error' },
        ],
        ['Info', 'Deleted orphan entries', { collector: 'test entry', count: 1, sample: '2' }],
        [
          'Warn',
          'Failed to clean orphan entries',
          { collector: 'test entry', count: 1, sample: '1' },
        ],
      ],
    );
  });
});

test('orphan collection warnings name filesystem conditions by their system error code', async () => {
  // A busy or read-only volume, an I/O fault or a vanished parent must be distinguishable in the
  // log; the raw message (which carries the path) still never is.
  await withDataRootAsync(async (dataRoot) => {
    const root = await guardedRoot(dataRoot, 'root');
    writeFileSync(join(root.path, '1'), 'x');
    utimesSync(join(root.path, '1'), oldDate, oldDate);

    const logs = makeLogCapture();
    await sweep(
      {
        label: 'test entry',
        candidates: listed(await list(root, 'file')),
        isLive: () => {
          throw Object.assign(new Error(`EBUSY: resource busy or locked, ${root.path}`), {
            code: 'EBUSY',
          });
        },
        minAgeMs,
        nowMs,
      },
      logs,
    );
    assert.deepEqual(logs.lines[0]?.annotations, {
      collector: 'test entry',
      name: '1',
      cause: 'System error EBUSY',
    });

    // A real readdir failure: the listed parent was replaced by a file.
    const parent = await guardedRoot(dataRoot, 'replaced');
    rmSync(parent.path, { recursive: true, force: true });
    writeFileSync(parent.path, 'not a directory');
    const listingLogs = makeLogCapture();
    const listing = await Effect.runPromise(
      Effect.scoped(
        listOrphanCandidates(parent, 'file', isIdName, 'test').pipe(
          Effect.provide(listingLogs.layer),
        ),
      ),
    );
    assert.equal(listing.status, 'unreadable');
    assert.deepEqual(
      listingLogs.lines.map((line) => [line.level, line.message, line.annotations]),
      [
        [
          'Warn',
          'Could not list orphan collection entries',
          { collector: 'test', path: parent.path, cause: 'System error ENOTDIR' },
        ],
      ],
    );
  });
});

test('sweepOrphans treats anything written after the sweep started as young', async () => {
  await withDataRootAsync(async (dataRoot) => {
    const root = await guardedRoot(dataRoot, 'root');
    writeFileSync(join(root.path, '1'), 'x');

    const stats = await sweep({
      label: 'test entry',
      candidates: listed(await list(root, 'file')),
      isLive: () => false,
      minAgeMs,
      // Far in the past: the file's real mtime is after this sweep's fixed clock.
      nowMs,
    });

    assert.deepEqual(stats.skippedYoung, ['1']);
  });
});

async function guardedRoot(dataRoot: string, ...segments: string[]): Promise<GuardedDirectory> {
  mkdirSync(join(dataRoot, ...segments), { recursive: true });
  const opened = await Effect.runPromise(
    Effect.scoped(openCollectorRoot(dataRoot, segments, 'test')),
  );
  assert.equal(opened.status, 'ready');
  if (opened.status !== 'ready') throw new Error('unreachable');
  return opened.directory;
}

function list(parent: GuardedDirectory, kind: 'file' | 'directory') {
  return Effect.runPromise(Effect.scoped(listOrphanCandidates(parent, kind, isIdName, 'test')));
}

/** Runs a sweep with its log lines captured, so a test can assert on them and nothing is printed. */
function sweep(input: Parameters<typeof sweepOrphans>[0], logs = makeLogCapture()) {
  return Effect.runPromise(Effect.scoped(sweepOrphans(input).pipe(Effect.provide(logs.layer))));
}

function listed(listing: OrphanListing): OrphanCandidate[] {
  assert.equal(listing.status, 'listed');
  return listing.status === 'listed' ? [...listing.candidates] : [];
}

function names(listing: OrphanListing) {
  return listed(listing).map((candidate) => candidate.name);
}

function withDataRoot(body: (dataRoot: string) => void) {
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-orphan-files-')));
  try {
    body(dataRoot);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

async function withDataRootAsync(body: (dataRoot: string) => Promise<void>) {
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-orphan-files-')));
  try {
    await body(dataRoot);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
}
