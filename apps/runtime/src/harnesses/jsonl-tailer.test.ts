import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import { runScoped } from '@isagi/testing';

import {
  discoverJsonlFiles,
  HarnessSourceUnreadable,
  jsonlFileState,
  readJsonlBytes,
  splitCompleteJsonlLines,
} from './jsonl-tailer.js';

test('tailer retains incomplete UTF-8 bytes until the newline completes the record', () => {
  const directory = mkdtempSync(join(tmpdir(), 'isagi-jsonl-tailer-'));
  const path = join(directory, '20.harness.jsonl');
  return runScoped(
    Effect.gen(function* () {
      const line = '{"message":"é"}\n';
      const bytes = Buffer.from(line, 'utf8');
      const splitAt = bytes.length - 2;
      writeFileSync(path, bytes.subarray(0, splitAt));
      const first = splitCompleteJsonlLines(yield* readJsonlBytes(path, 0, splitAt));
      assert.deepEqual(first.completeLines, []);
      assert.equal(first.trailingBytes.length, splitAt);

      appendFileSync(path, bytes.subarray(splitAt));
      const second = splitCompleteJsonlLines(
        Buffer.concat([
          first.trailingBytes,
          yield* readJsonlBytes(path, splitAt, bytes.length - splitAt),
        ]),
      );
      assert.deepEqual(second.completeLines, ['{"message":"é"}']);
      assert.equal(second.trailingBytes.length, 0);
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(directory, { recursive: true, force: true }))),
    ),
  );
});

test('append preserves file identity while replacement changes it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'isagi-jsonl-tailer-'));
  const path = join(directory, '20.harness.jsonl');
  return runScoped(
    Effect.gen(function* () {
      writeFileSync(path, '{}\n');
      const first = yield* jsonlFileState(path);
      appendFileSync(path, '{}\n');
      const appended = yield* jsonlFileState(path);
      assert.equal(first?.identity, appended?.identity);
      rmSync(path);
      assert.equal(yield* jsonlFileState(path), null);
      writeFileSync(path, '{}\n');
      const second = yield* jsonlFileState(path);
      assert.notEqual(first?.identity, second?.identity);
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(directory, { recursive: true, force: true }))),
    ),
  );
});

test(
  'tailer rejects symbolic-link files and artifact directories',
  { skip: process.platform === 'win32' },
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'isagi-jsonl-tailer-links-'));
    const linkedDirectory = join(directory, 'linked');
    const realFile = join(directory, 'real.harness.jsonl');
    const linkedFile = join(directory, 'linked.harness.jsonl');
    return runScoped(
      Effect.gen(function* () {
        writeFileSync(realFile, '{}\n');
        symlinkSync(realFile, linkedFile);
        const linkedRead = yield* Effect.flip(readJsonlBytes(linkedFile, 0, 3));
        assert.ok(linkedRead instanceof HarnessSourceUnreadable);
        assert.equal(linkedRead.reason, 'not_regular_file');
        const linkedState = yield* Effect.flip(jsonlFileState(linkedFile));
        assert.equal(linkedState.reason, 'not_regular_file');
        symlinkSync(directory, linkedDirectory);
        const linkedDiscovery = yield* Effect.flip(discoverJsonlFiles(linkedDirectory));
        assert.equal(linkedDiscovery.reason, 'not_directory');
        assert.equal(linkedDiscovery.path, linkedDirectory);
      }).pipe(
        Effect.ensuring(Effect.sync(() => rmSync(directory, { recursive: true, force: true }))),
      ),
    );
  },
);

test('a missing artifact directory is an empty source list and a vanished source is typed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'isagi-jsonl-tailer-missing-'));
  return runScoped(
    Effect.gen(function* () {
      assert.deepEqual(yield* discoverJsonlFiles(join(directory, 'absent')), []);
      writeFileSync(join(directory, 'b.harness.jsonl'), '{}\n');
      writeFileSync(join(directory, 'a.harness.jsonl'), '{}\n');
      writeFileSync(join(directory, '.hidden.harness.jsonl'), '{}\n');
      writeFileSync(join(directory, 'notes.txt'), '');
      assert.deepEqual(yield* discoverJsonlFiles(directory), [
        join(directory, 'a.harness.jsonl'),
        join(directory, 'b.harness.jsonl'),
      ]);
      const vanished = yield* Effect.flip(
        readJsonlBytes(join(directory, 'gone.harness.jsonl'), 0, 3),
      );
      assert.equal(vanished.reason, 'disappeared');
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(directory, { recursive: true, force: true }))),
    ),
  );
});
