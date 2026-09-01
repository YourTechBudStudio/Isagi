import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import {
  editorSessionSocketPath,
  maxSessionSocketPathBytes,
} from '../../editor-contexts/launch-spec.js';
import {
  EditorInstallIo,
  EditorInstallIoLive,
  runtimeSessionSocketDirectory,
} from '../install-io.js';

/**
 * The session socket is the one shared editor path anchored outside the data
 * directory. A data root's depth is unbounded — Isagi's own worktrees nest
 * under `data/.isagi/worktrees/<n>/<hash>/` — and a UNIX socket path is capped
 * near 104 bytes by the kernel, so anchoring it there made whether the editor
 * can launch a property of where the user keeps their projects.
 */
test('the session socket directory is anchored outside the data directory', () => {
  const directory = runtimeSessionSocketDirectory();
  assert.equal(path.dirname(directory), tmpdir());
  assert.match(path.basename(directory), /^isagi-editor-[0-9a-f]{12}$/u);
});

test('two runtimes never share a session socket directory', () => {
  const directories = new Set(Array.from({ length: 32 }, () => runtimeSessionSocketDirectory()));
  assert.equal(directories.size, 32);
});

/**
 * The regression this fixes. Every one of these launched before only by
 * accident of path length; the deep-worktree case did not launch at all.
 */
test('a socket path fits the cap regardless of how deep the data directory is', () => {
  for (const dataDirectory of [
    '/Users/somebody/Library/Application Support/Isagi',
    '/Users/somebody/Work/projects/Isagi/data/.isagi/worktrees/1/eefa16ee8e081094/data/.isagi',
    `/home/${'a'.repeat(32)}/very/deeply/nested/checkout/data/.isagi`,
  ]) {
    // The data directory is now irrelevant to the socket budget, which is the
    // point: the assertion is that its depth cannot influence the result.
    const socketPath = editorSessionSocketPath(runtimeSessionSocketDirectory(), 999_999, 'abcdef');
    assert.ok(
      Buffer.byteLength(socketPath) <= maxSessionSocketPathBytes,
      `${socketPath} (${Buffer.byteLength(socketPath)} bytes) for ${dataDirectory}`,
    );
  }
});

test('shared editor state creates a private socket directory and reuses it', async () => {
  const editorsPath = path.join(
    tmpdir(),
    `isagi-editors-${Math.random().toString(16).slice(2)}`,
    'editors',
  );
  const run = Effect.gen(function* () {
    const io = yield* EditorInstallIo;
    const first = yield* io.prepareEditorState({ editorsPath });
    const second = yield* io.prepareEditorState({ editorsPath });
    return { first, second };
  }).pipe(Effect.provide(EditorInstallIoLive));

  const { first, second } = await Effect.runPromise(run);
  try {
    // Stable across calls: an installed and a reused resolution both prepare
    // shared state, and they must name the same directory.
    assert.equal(first.sessionSocketDirectory, second.sessionSocketDirectory);
    assert.equal(path.dirname(first.sessionSocketDirectory), tmpdir());
    // Owner-only, because on Linux this sits in world-writable `/tmp`.
    assert.equal(statSync(first.sessionSocketDirectory).mode & 0o777, 0o700);
    // The rest of the shared state stays where it was.
    assert.equal(path.dirname(path.dirname(first.userDataPath)), editorsPath);
  } finally {
    await rm(first.sessionSocketDirectory, { force: true, recursive: true });
    await rm(path.dirname(editorsPath), { force: true, recursive: true });
  }
});
