import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import { EditorInstallIo, EditorInstallIoLive } from '../install-io.js';

/**
 * The settings Isagi seeds into a Code Server user-data directory the first
 * time it prepares one. Everything here is about the *seed once* contract: a
 * default the user immediately owns, not a policy Isagi re-imposes.
 */
function prepare(editorsPath: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const io = yield* EditorInstallIo;
      return yield* io.prepareEditorState({ editorsPath });
    }).pipe(Effect.provide(EditorInstallIoLive)),
  );
}

async function withEditorsPath<A>(body: (editorsPath: string) => Promise<A>): Promise<A> {
  const root = path.join(tmpdir(), `isagi-editor-defaults-${Math.random().toString(16).slice(2)}`);
  const editorsPath = path.join(root, 'editors');
  try {
    return await body(editorsPath);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

function userSettingsPath(shared: { readonly userDataPath: string }) {
  return path.join(shared.userDataPath, 'User', 'settings.json');
}

test('first setup seeds the editor with AI features disabled', async () => {
  await withEditorsPath(async (editorsPath) => {
    const shared = await prepare(editorsPath);
    const settings = JSON.parse(await readFile(userSettingsPath(shared), 'utf8')) as Record<
      string,
      unknown
    >;

    // The workbench's own master switch for the chat stack bundled into this
    // Code Server build, which it sets itself when builtin chat is disabled.
    assert.deepEqual(settings, { 'chat.disableAIFeatures': true });
  });
});

/**
 * The half that matters. `prepareEditorState` runs on every resolution —
 * installed *and* reused — so a write without `wx` would silently revert a
 * user's own setting on the next launch, and take the rest of their settings
 * file with it.
 */
test('a settings file the user has since edited is never rewritten', async () => {
  await withEditorsPath(async (editorsPath) => {
    const shared = await prepare(editorsPath);
    const owned = `${JSON.stringify(
      { 'chat.disableAIFeatures': false, 'workbench.colorTheme': 'Tomorrow Night Blue' },
      null,
      2,
    )}\n`;
    await writeFile(userSettingsPath(shared), owned, 'utf8');

    await prepare(editorsPath);

    assert.equal(await readFile(userSettingsPath(shared), 'utf8'), owned);
  });
});

test('the seeded file is the user profile settings VS Code actually reads', async () => {
  await withEditorsPath(async (editorsPath) => {
    const shared = await prepare(editorsPath);
    // `--user-data-dir/User/settings.json` is where the workbench looks; the
    // path is deliberately not on `EditorSharedStatePaths`, because no caller
    // outside provisioning needs it.
    assert.equal(
      userSettingsPath(shared),
      path.join(editorsPath, 'code-server', 'user-data', 'User', 'settings.json'),
    );
  });
});
