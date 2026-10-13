import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import { ExecutableNotFound, resolveExecutableOnPath } from './executable-path.js';

function withDirectories(body: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'isagi-executable-path-'));
  return body(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

function writeFile(path: string, mode: number) {
  writeFileSync(path, '#!/bin/sh\n', 'utf8');
  chmodSync(path, mode);
}

test('the first executable match on PATH wins, as an absolute path', () =>
  withDirectories(async (root) => {
    for (const directory of ['a', 'b']) mkdirSync(join(root, directory));
    writeFile(join(root, 'b', 'claude'), 0o755);
    writeFile(join(root, 'a', 'claude'), 0o755);
    const pathValue = ['relative/bin', '', join(root, 'a'), join(root, 'b')].join(delimiter);

    const found = await Effect.runPromise(resolveExecutableOnPath('claude', pathValue));

    assert.equal(found, join(root, 'a', 'claude'));
  }));

test('a non-executable file or a directory is skipped', () =>
  withDirectories(async (root) => {
    for (const directory of ['plain', 'dir', 'real']) mkdirSync(join(root, directory));
    writeFile(join(root, 'plain', 'claude'), 0o644);
    mkdirSync(join(root, 'dir', 'claude'));
    writeFile(join(root, 'real', 'claude'), 0o755);
    const pathValue = ['plain', 'dir', 'real'].map((d) => join(root, d)).join(delimiter);

    const found = await Effect.runPromise(resolveExecutableOnPath('claude', pathValue));

    assert.equal(found, join(root, 'real', 'claude'));
  }));

test('no match fails with ExecutableNotFound', () =>
  withDirectories(async (root) => {
    for (const pathValue of [root, undefined]) {
      const error = await Effect.runPromise(
        Effect.flip(resolveExecutableOnPath('claude', pathValue)),
      );
      assert.ok(error instanceof ExecutableNotFound);
      assert.equal(error.executable, 'claude');
    }
  }));
