import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';

import { Effect, Exit, Scope } from 'effect';

import {
  contentPathFor,
  makeWorkflowContentStore,
  type ContentCapture,
  type ContentGcResult,
  type WorkflowContentStoreInstance,
} from './content-store.js';

const graceMs = 60 * 60_000;

interface Fixture {
  readonly dataRoot: string;
  readonly contentRoot: string;
  /** A folder outside the data root, standing in for a user's worktree. */
  readonly outside: string;
  readonly store: WorkflowContentStoreInstance;
}

function withStore(body: (fixture: Fixture) => Promise<void>) {
  return async () => {
    const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-content-gc-')));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-content-gc-outside-')));
    const contentRoot = join(dataRoot, 'workflow-content');
    try {
      await body({ dataRoot, contentRoot, outside, store: makeWorkflowContentStore(dataRoot) });
    } finally {
      for (const path of [dataRoot, outside]) {
        try {
          chmodSync(join(path, 'workflow-content'), 0o755);
        } catch {
          // Only the unreadable-root case changes permissions.
        }
        rmSync(path, { recursive: true, force: true });
      }
    }
  };
}

const hashOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** A capture in a scope the test closes itself, synchronously (the finalizer is synchronous). */
function openCapture(store: WorkflowContentStoreInstance) {
  const scope = Effect.runSync(Scope.make());
  const capture = Effect.runSync(Scope.extend(store.service.openCapture, scope));
  return { capture, close: () => Effect.runSync(Scope.close(scope, Exit.void)) };
}

function put(capture: ContentCapture, source: Readable | Buffer) {
  const stream = Buffer.isBuffer(source) ? Readable.from([source]) : source;
  return Effect.runPromise(capture.put({ source: stream }));
}

async function publish(store: WorkflowContentStoreInstance, bytes: Buffer) {
  const { capture, close } = openCapture(store);
  try {
    return await put(capture, bytes);
  } finally {
    close();
  }
}

/** Writes a blob straight to disk, as an earlier capture would have left it. */
function plantBlob(contentRoot: string, bytes: Buffer, ageMs = 0) {
  const hash = hashOf(bytes);
  const path = contentPathFor(contentRoot, `sha256:${hash}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  if (ageMs > 0) backdate(path, ageMs);
  return { hash, path };
}

function plantTemp(contentRoot: string, ageMs = 0) {
  const path = join(contentRoot, 'incoming', `${randomUUID()}.tmp`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'partial');
  if (ageMs > 0) backdate(path, ageMs);
  return path;
}

function backdate(path: string, ageMs: number) {
  const at = new Date(Date.now() - ageMs);
  utimesSync(path, at, at);
}

function sweep(
  store: WorkflowContentStoreInstance,
  options: { readonly nowMs?: number; readonly mark?: ReadonlySet<string> } = {},
) {
  return store.collectGarbage({
    nowMs: options.nowMs ?? Date.now(),
    minAgeMs: graceMs,
    referencedHashes: () => options.mark ?? new Set(),
  });
}

/** Far enough ahead that everything on disk is past the grace period. */
const later = () => Date.now() + 2 * graceMs;

function stats(result: ContentGcResult) {
  assert.equal(result.status, 'swept', `expected a sweep, got ${JSON.stringify(result)}`);
  return (result as Extract<ContentGcResult, { status: 'swept' }>).stats;
}

function incomingEntries(contentRoot: string) {
  const incoming = join(contentRoot, 'incoming');
  return existsSync(incoming) ? readdirSync(incoming) : [];
}

async function waitFor(condition: () => boolean) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('The condition never became true.');
}

test(
  'old unreferenced blobs and temps are deleted; referenced and young ones are kept',
  withStore(async ({ contentRoot, store }) => {
    const orphan = plantBlob(contentRoot, Buffer.from('orphan'), 2 * graceMs);
    const referenced = plantBlob(contentRoot, Buffer.from('referenced'), 2 * graceMs);
    const young = plantBlob(contentRoot, Buffer.from('young'));
    const oldTemp = plantTemp(contentRoot, 2 * graceMs);
    const youngTemp = plantTemp(contentRoot);

    const result = stats(await sweep(store, { mark: new Set([referenced.hash]) }));

    assert.equal(existsSync(orphan.path), false);
    assert.equal(existsSync(oldTemp), false);
    assert.equal(existsSync(referenced.path), true);
    assert.equal(existsSync(young.path), true);
    assert.equal(existsSync(youngTemp), true);
    assert.deepEqual(
      [...result.deleted].sort(),
      [`${orphan.hash}.json`, oldTemp.split('/').pop()].sort(),
    );
    assert.equal(
      result.kept,
      1,
      'the referenced blob is kept; young entries never reach the sweep',
    );
    assert.equal(existsSync(join(contentRoot, orphan.hash.slice(0, 2))), true, 'shards stay');
    assert.equal(existsSync(join(contentRoot, 'incoming')), true, 'incoming stays');
  }),
);

test(
  'reusing an old blob refreshes it, and a capture holds it until it closes',
  withStore(async ({ contentRoot, store }) => {
    const bytes = Buffer.from('reused');
    const blob = plantBlob(contentRoot, bytes, 2 * graceMs);
    const startedAt = Date.now();

    const { capture, close } = openCapture(store);
    await put(capture, bytes);
    assert.ok(statSync(blob.path).mtimeMs >= startedAt - 1000, 'reuse refreshed the mtime');

    assert.deepEqual(await sweep(store), { status: 'skipped', reason: 'nothing_old' });
    assert.equal(existsSync(blob.path), true, 'kept and refreshed with an empty mark');

    const held = stats(await sweep(store, { nowMs: later() }));
    assert.equal(held.kept, 1, 'still kept past the grace period while the capture is open');
    assert.equal(existsSync(blob.path), true);

    close();
    stats(await sweep(store, { nowMs: later() }));
    assert.equal(existsSync(blob.path), false, 'collected once the capture closed');
  }),
);

test(
  'a newly published blob and a temp still being written are kept while their capture is open',
  withStore(async ({ contentRoot, store }) => {
    const { capture, close } = openCapture(store);
    const published = await put(capture, Buffer.from('fresh'));
    const blobPath = contentPathFor(contentRoot, published.contentRef);

    const source = new PassThrough();
    source.write('still streaming');
    const pending = put(capture, source);
    await waitFor(() => incomingEntries(contentRoot).length === 1);

    const during = stats(await sweep(store, { nowMs: later() }));
    assert.equal(during.kept, 2, 'the held blob and the live temp');
    assert.equal(existsSync(blobPath), true);
    assert.equal(incomingEntries(contentRoot).length, 1);

    source.end();
    const streamed = await pending;
    close();
    const after = stats(await sweep(store, { nowMs: later() }));
    assert.equal(existsSync(blobPath), false);
    assert.equal(existsSync(contentPathFor(contentRoot, streamed.contentRef)), false);
    assert.equal(after.deleted.length, 2);
  }),
);

test(
  'a blob swept before a capture reuses it is republished and still verifies',
  withStore(async ({ contentRoot, store }) => {
    const bytes = Buffer.from('swept then reused');
    const blob = plantBlob(contentRoot, bytes, 2 * graceMs);
    stats(await sweep(store));
    assert.equal(existsSync(blob.path), false);

    const { contentRef } = await publish(store, bytes);
    assert.equal(existsSync(blob.path), true);
    assert.deepEqual(await Effect.runPromise(store.service.readAll(contentRef)), bytes);
  }),
);

test(
  'a capture that commits and releases after the mark was read is kept by release tracking',
  withStore(async ({ contentRoot, store }) => {
    const bytes = Buffer.from('handoff');
    const { capture, close } = openCapture(store);
    const { contentRef } = await put(capture, bytes);
    const hash = contentRef.slice('sha256:'.length);
    const blobPath = contentPathFor(contentRoot, contentRef);
    const references = new Set<string>();

    const first = await store.collectGarbage({
      nowMs: later(),
      minAgeMs: graceMs,
      referencedHashes: () => {
        const staleMark = new Set(references);
        references.add(hash); // the checkpoint row commits
        close(); // and the capture's scope closes, releasing its hold
        return staleMark;
      },
    });
    assert.equal(stats(first).kept, 1);
    assert.equal(existsSync(blobPath), true, 'only releasedDuringSweep protected it');

    stats(await sweep(store, { nowMs: later(), mark: references }));
    assert.equal(existsSync(blobPath), true, 'the next sweep keeps it through the fresh mark');

    references.delete(hash);
    stats(await sweep(store, { nowMs: later(), mark: references }));
    assert.equal(existsSync(blobPath), false, 'unreferenced, it is collected');
  }),
);

test(
  'overlapping sweeps are refused, a failing mark removes nothing, and nothing old skips the mark',
  withStore(async ({ contentRoot, store }) => {
    const blob = plantBlob(contentRoot, Buffer.from('old'), 2 * graceMs);

    const running = sweep(store, { mark: new Set([blob.hash]) });
    assert.deepEqual(await sweep(store), { status: 'skipped', reason: 'already_running' });
    stats(await running);

    await assert.rejects(
      store.collectGarbage({
        nowMs: Date.now(),
        minAgeMs: graceMs,
        referencedHashes: () => {
          throw new Error('database unavailable');
        },
      }),
      /database unavailable/,
    );
    assert.equal(existsSync(blob.path), true, 'an aborted sweep removes nothing');

    stats(await sweep(store));
    assert.equal(existsSync(blob.path), false, 'a later sweep works');

    plantBlob(contentRoot, Buffer.from('young'));
    let markReads = 0;
    const quiet = await store.collectGarbage({
      nowMs: Date.now(),
      minAgeMs: graceMs,
      referencedHashes: () => {
        markReads += 1;
        return new Set();
      },
    });
    assert.deepEqual(quiet, { status: 'skipped', reason: 'nothing_old' });
    assert.equal(markReads, 0);
  }),
);

test(
  'closing a capture while a stream is in flight fails the put and leaks no hold',
  withStore(async ({ contentRoot, store }) => {
    const bytes = Buffer.from('interrupted');
    const blobPath = contentPathFor(contentRoot, `sha256:${hashOf(bytes)}`);
    const { capture, close } = openCapture(store);
    const source = new PassThrough();
    source.write(bytes);
    const pending = Effect.runPromiseExit(capture.put({ source }));
    await waitFor(() => incomingEntries(contentRoot).length === 1);

    close();
    source.end();
    const exit = await pending;
    assert.ok(Exit.isFailure(exit));
    assert.equal(
      exit.cause._tag === 'Fail' ? exit.cause.error._tag : exit.cause._tag,
      'ContentPublishError',
    );
    assert.equal(existsSync(blobPath), false);
    assert.deepEqual(incomingEntries(contentRoot), []);

    await publish(store, bytes);
    assert.equal(existsSync(blobPath), true);
    stats(await sweep(store, { nowMs: later() }));
    assert.equal(existsSync(blobPath), false, 'no hold from either capture remains');
  }),
);

test(
  'closing a capture just after its stream ends leaves nothing held, whichever way the race goes',
  withStore(async ({ contentRoot, store }) => {
    const bytes = Buffer.from('closed on the next tick');
    const blobPath = contentPathFor(contentRoot, `sha256:${hashOf(bytes)}`);
    const { capture, close } = openCapture(store);
    const pending = Effect.runPromiseExit(capture.put({ source: Readable.from([bytes]) }));
    await new Promise((resolve) => setImmediate(resolve));
    close();
    await pending;

    await sweep(store, { nowMs: later() });
    assert.equal(existsSync(blobPath), false);
    assert.deepEqual(incomingEntries(contentRoot), []);
  }),
);

test(
  'a closed capture refuses new puts and writes nothing',
  withStore(async ({ contentRoot, store }) => {
    const bytes = Buffer.from('too late');
    const { capture, close } = openCapture(store);
    close();
    const error = await Effect.runPromise(
      Effect.flip(capture.put({ source: Readable.from([bytes]) })),
    );
    assert.equal(error._tag, 'ContentPublishError');
    assert.equal(existsSync(contentPathFor(contentRoot, `sha256:${hashOf(bytes)}`)), false);
    assert.deepEqual(incomingEntries(contentRoot), []);
  }),
);

test(
  'the collector never reaches through links, odd names or wrong types',
  withStore(async ({ dataRoot, contentRoot, outside, store }) => {
    const old = 2 * graceMs;
    const real = plantBlob(contentRoot, Buffer.from('real orphan'), old);

    // A symlinked incoming whose target holds an old temp-shaped file.
    const fakeIncoming = join(outside, 'incoming');
    mkdirSync(fakeIncoming);
    const decoyTemp = join(fakeIncoming, `${randomUUID()}.tmp`);
    writeFileSync(decoyTemp, 'decoy');
    backdate(decoyTemp, old);
    symlinkSync(fakeIncoming, join(contentRoot, 'incoming'));

    // A symlinked shard whose target holds an old blob-shaped file.
    const shardBytes = Buffer.from('shard decoy');
    const shardHash = hashOf(shardBytes);
    const fakeShard = join(outside, 'shard');
    mkdirSync(fakeShard);
    const decoyBlob = join(fakeShard, `${shardHash}.json`);
    writeFileSync(decoyBlob, shardBytes);
    backdate(decoyBlob, old);
    // The fixed inputs give distinct shards: 4d (real), e9 (decoy), 22 (link), 2b (wrong type).
    symlinkSync(fakeShard, join(contentRoot, shardHash.slice(0, 2)));

    // A blob-shaped symlink to an outside file, odd names, and a wrong-type entry.
    const linkBytes = Buffer.from('linked');
    const linkHash = hashOf(linkBytes);
    const linkTarget = join(outside, 'target.json');
    writeFileSync(linkTarget, linkBytes);
    backdate(linkTarget, old);
    const linkPath = contentPathFor(contentRoot, `sha256:${linkHash}`);
    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync(linkTarget, linkPath);
    const shard = dirname(real.path);
    const oddNames = [
      join(shard, 'notes.json'),
      join(shard, `ff${'0'.repeat(62)}.json`), // blob-shaped, but not this shard's prefix
      join(shard, `${real.hash}.json.bak`),
      join(contentRoot, 'zz', `zz${'0'.repeat(62)}.json`), // not a shard name
      join(contentRoot, `${'0'.repeat(64)}.json`), // a blob outside any shard
    ];
    for (const path of oddNames) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'odd');
      backdate(path, old);
    }
    const wrongType = contentPathFor(contentRoot, `sha256:${hashOf(Buffer.from('dir'))}`);
    mkdirSync(wrongType, { recursive: true });
    backdate(wrongType, old);

    const result = stats(await sweep(store));
    assert.deepEqual(result.deleted, [`${real.hash}.json`]);
    for (const path of [decoyTemp, decoyBlob, linkTarget, linkPath, wrongType, ...oddNames]) {
      assert.equal(existsSync(path), true, `${path} survives`);
    }

    // A symlinked collector root is never entered.
    const fakeRoot = join(outside, 'workflow-content');
    renameSync(contentRoot, join(dataRoot, 'moved'));
    mkdirSync(join(fakeRoot, 'aa'), { recursive: true });
    const rootDecoy = join(fakeRoot, 'aa', `aa${'1'.repeat(62)}.json`);
    writeFileSync(rootDecoy, 'decoy');
    backdate(rootDecoy, old);
    symlinkSync(fakeRoot, contentRoot);
    assert.deepEqual(await sweep(store), { status: 'skipped', reason: 'root_unusable' });
    assert.equal(existsSync(rootDecoy), true);
  }),
);

test(
  'a shard swapped for a link after listing is skipped as unsafe',
  withStore(async ({ contentRoot, outside, store }) => {
    const blob = plantBlob(contentRoot, Buffer.from('swapped'), 2 * graceMs);
    const shard = dirname(blob.path);
    const decoyShard = join(outside, 'decoy-shard');
    mkdirSync(decoyShard);
    const decoy = join(decoyShard, `${blob.hash}.json`);
    writeFileSync(decoy, 'decoy');
    backdate(decoy, 2 * graceMs);

    const result = stats(
      await store.collectGarbage({
        nowMs: Date.now(),
        minAgeMs: graceMs,
        referencedHashes: () => {
          renameSync(shard, join(outside, 'real-shard'));
          symlinkSync(decoyShard, shard);
          return new Set();
        },
      }),
    );
    assert.equal(existsSync(decoy), true);
    assert.deepEqual(result.skippedUnsafe, [`${blob.hash}.json`]);
    assert.deepEqual(result.deleted, []);
  }),
);

test(
  'a root replaced by a file is skipped, and collection resumes once it is restored',
  withStore(async ({ contentRoot, store }) => {
    writeFileSync(contentRoot, 'not a directory');
    assert.deepEqual(await sweep(store), { status: 'skipped', reason: 'root_unusable' });

    rmSync(contentRoot);
    const blob = plantBlob(contentRoot, Buffer.from('after restore'), 2 * graceMs);
    stats(await sweep(store));
    assert.equal(existsSync(blob.path), false);
  }),
);

test(
  'an unreadable root is skipped, and collection resumes once it is readable',
  {
    skip:
      process.platform === 'win32' || process.getuid?.() === 0
        ? 'permissions are not enforced here'
        : false,
  },
  withStore(async ({ contentRoot, store }) => {
    const blob = plantBlob(contentRoot, Buffer.from('locked'), 2 * graceMs);
    chmodSync(contentRoot, 0o000);
    assert.deepEqual(await sweep(store), { status: 'skipped', reason: 'root_unusable' });

    chmodSync(contentRoot, 0o755);
    assert.equal(existsSync(blob.path), true, 'nothing was deleted while unreadable');
    stats(await sweep(store));
    assert.equal(existsSync(blob.path), false);
  }),
);
