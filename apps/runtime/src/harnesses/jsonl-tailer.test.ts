import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  discoverHarnessJsonlFiles,
  jsonlFileState,
  readJsonlBytes,
  splitCompleteJsonlLines,
} from './jsonl-tailer.js';

test('tailer retains incomplete UTF-8 bytes until the newline completes the record', () => {
  const directory = mkdtempSync(join(tmpdir(), 'isagi-jsonl-tailer-'));
  const path = join(directory, '20.harness.jsonl');
  try {
    const line = '{"message":"é"}\n';
    const bytes = Buffer.from(line, 'utf8');
    const splitAt = bytes.length - 2;
    writeFileSync(path, bytes.subarray(0, splitAt));
    const first = splitCompleteJsonlLines(readJsonlBytes(path, 0, splitAt));
    assert.deepEqual(first.completeLines, []);
    assert.equal(first.trailingBytes.length, splitAt);

    appendFileSync(path, bytes.subarray(splitAt));
    const second = splitCompleteJsonlLines(
      Buffer.concat([first.trailingBytes, readJsonlBytes(path, splitAt, bytes.length - splitAt)]),
    );
    assert.deepEqual(second.completeLines, ['{"message":"é"}']);
    assert.equal(second.trailingBytes.length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('append preserves file identity while replacement changes it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'isagi-jsonl-tailer-'));
  const path = join(directory, '20.harness.jsonl');
  try {
    writeFileSync(path, '{}\n');
    const first = jsonlFileState(path);
    appendFileSync(path, '{}\n');
    const appended = jsonlFileState(path);
    assert.equal(first?.identity, appended?.identity);
    rmSync(path);
    writeFileSync(path, '{}\n');
    const second = jsonlFileState(path);
    assert.notEqual(first?.identity, second?.identity);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  'tailer rejects symbolic-link files and artifact directories',
  { skip: process.platform === 'win32' },
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'isagi-jsonl-tailer-links-'));
    const linkedDirectory = join(directory, 'linked');
    const realFile = join(directory, 'real.harness.jsonl');
    const linkedFile = join(directory, 'linked.harness.jsonl');
    try {
      writeFileSync(realFile, '{}\n');
      symlinkSync(realFile, linkedFile);
      assert.throws(() => readJsonlBytes(linkedFile, 0, 3));
      symlinkSync(directory, linkedDirectory);
      assert.throws(() => discoverHarnessJsonlFiles(linkedDirectory));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
