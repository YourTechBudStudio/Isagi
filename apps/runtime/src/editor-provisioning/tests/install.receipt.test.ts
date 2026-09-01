import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Effect } from 'effect';

import { provisionCodeServer } from '../install.js';
import { editorInstallReceiptPath, readEditorInstallReceipt } from '../receipt.js';
import {
  pinnedVersion,
  recordingInstallIo,
  testArtifact,
  writeExecutable,
} from './test-support.js';

function makeRoots() {
  const root = mkdtempSync(join(tmpdir(), 'isagi-editor-provisioning-'));
  return {
    root,
    paths: { toolsPath: join(root, 'tools'), editorsPath: join(root, 'editors') },
    installRoot: join(root, 'tools', 'code-server', pinnedVersion),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function run(paths: { toolsPath: string; editorsPath: string }, behaviour = {}) {
  const recorder = recordingInstallIo(behaviour);
  const effect = provisionCodeServer({
    io: recorder.io,
    paths,
    artifact: testArtifact,
    platformKey: 'darwin-arm64',
    version: pinnedVersion,
    onPhase: () => Effect.void,
  });
  return { recorder, effect };
}

function writeCompleteInstall(
  installRoot: string,
  overrides: Partial<{
    receiptVersion: number;
    version: string;
    platformKey: string;
    artifactSha256: string;
    executablePath: string;
  }> = {},
) {
  writeExecutable(join(installRoot, testArtifact.executablePath));
  writeFileSync(
    editorInstallReceiptPath(installRoot),
    JSON.stringify({
      receiptVersion: 1,
      version: pinnedVersion,
      platformKey: 'darwin-arm64',
      artifactSha256: testArtifact.sha256,
      executablePath: testArtifact.executablePath,
      completedAt: '2026-08-31T00:00:00.000Z',
      ...overrides,
    }),
  );
}

test('a matching receipt is reused without a download, a hash, or an extraction', async () => {
  const roots = makeRoots();
  try {
    writeCompleteInstall(roots.installRoot);
    const { recorder, effect } = run(roots.paths);
    const resolved = await Effect.runPromise(effect);

    assert.equal(resolved.installRoot, roots.installRoot);
    assert.equal(resolved.executablePath, join(roots.installRoot, testArtifact.executablePath));
    // The whole point of AC2: the only IO is proving the recorded executable is
    // still executable, plus preparing shared state. No network, no re-hash.
    assert.deepEqual(recorder.calls, ['assertExecutable', 'prepareEditorState']);
    assert.ok(!existsSync(join(roots.paths.toolsPath, '.staging')));
  } finally {
    roots.cleanup();
  }
});

test('a receipt that does not describe the pinned installation forces a re-provision', async () => {
  const cases = [
    { name: 'version mismatch', overrides: { version: '4.0.0' } },
    { name: 'platform mismatch', overrides: { platformKey: 'linux-x64' } },
    { name: 'digest mismatch', overrides: { artifactSha256: 'f'.repeat(64) } },
    { name: 'future receipt version', overrides: { receiptVersion: 2 } },
    // The executable path is part of the identity a receipt has to match, not
    // something the reuse path adopts from it.
    { name: 'executable path mismatch', overrides: { executablePath: 'bin/other' } },
    {
      name: 'executable path escaping the install root',
      overrides: { executablePath: '../../../../bin/sh' },
    },
  ];

  for (const item of cases) {
    const roots = makeRoots();
    try {
      writeCompleteInstall(roots.installRoot, item.overrides);
      const { recorder, effect } = run(roots.paths);
      await Effect.runPromise(effect);
      assert.ok(recorder.calls.includes('downloadTo'), `${item.name} re-downloads`);

      // The rebuilt install carries a receipt that does describe the pin.
      const receipt = readEditorInstallReceipt(roots.installRoot);
      assert.equal(receipt?.version, pinnedVersion);
      assert.equal(receipt?.platformKey, 'darwin-arm64');
      assert.equal(receipt?.artifactSha256, testArtifact.sha256);
    } finally {
      roots.cleanup();
    }
  }
});

test('an undecodable receipt is re-provisioned rather than repaired', async () => {
  const roots = makeRoots();
  try {
    writeExecutable(join(roots.installRoot, testArtifact.executablePath));
    writeFileSync(editorInstallReceiptPath(roots.installRoot), '{ not json');
    const { recorder, effect } = run(roots.paths);
    await Effect.runPromise(effect);
    assert.ok(recorder.calls.includes('downloadTo'));
    assert.equal(readEditorInstallReceipt(roots.installRoot)?.version, pinnedVersion);
  } finally {
    roots.cleanup();
  }
});

test('a receipt whose executable is gone is re-provisioned', async () => {
  const roots = makeRoots();
  try {
    writeCompleteInstall(roots.installRoot);
    rmSync(join(roots.installRoot, testArtifact.executablePath));
    const { recorder, effect } = run(roots.paths);
    await Effect.runPromise(effect);
    // It asks once, is told no, and falls through to a full provision.
    assert.equal(recorder.calls[0], 'assertExecutable');
    assert.ok(recorder.calls.includes('downloadTo'));
  } finally {
    roots.cleanup();
  }
});

test('the receipt is written last, so its presence is the completion record', async () => {
  const roots = makeRoots();
  try {
    // Extraction is the last observable step before the publish; at that point
    // nothing at the install root may claim completion yet.
    let receiptExistedDuringExtract = true;
    const recorder = recordingInstallIo({
      observe: () =>
        Effect.sync(() => {
          receiptExistedDuringExtract =
            receiptExistedDuringExtract && existsSync(editorInstallReceiptPath(roots.installRoot));
        }),
    });
    await Effect.runPromise(
      provisionCodeServer({
        io: recorder.io,
        paths: roots.paths,
        artifact: testArtifact,
        platformKey: 'darwin-arm64',
        version: pinnedVersion,
        onPhase: () => Effect.void,
      }),
    );
    assert.equal(receiptExistedDuringExtract, false);

    const receipt = JSON.parse(readFileSync(editorInstallReceiptPath(roots.installRoot), 'utf8'));
    assert.equal(receipt.receiptVersion, 1);
    assert.equal(receipt.executablePath, testArtifact.executablePath);
    // Relative, so the install root can move with the data directory.
    assert.ok(!String(receipt.executablePath).startsWith('/'));
    // And no temporary file survives the atomic write.
    assert.ok(!existsSync(`${editorInstallReceiptPath(roots.installRoot)}.tmp`));
  } finally {
    roots.cleanup();
  }
});

test('an incomplete previous attempt is replaced rather than merged into', async () => {
  const roots = makeRoots();
  try {
    // A stray file from an attempt that died between rename and receipt write.
    writeExecutable(join(roots.installRoot, 'leftover', 'junk'));
    const { effect } = run(roots.paths);
    await Effect.runPromise(effect);
    assert.ok(!existsSync(join(roots.installRoot, 'leftover')));
    assert.ok(existsSync(join(roots.installRoot, testArtifact.executablePath)));
  } finally {
    roots.cleanup();
  }
});

test('a receipt cannot redirect the resolved executable outside the install root', async () => {
  const roots = makeRoots();
  try {
    // Everything a matching receipt needs except the path, which points at a
    // real executable outside the verified tree. If the path were trusted, the
    // reuse branch would report `ready` for `/bin/sh`.
    writeCompleteInstall(roots.installRoot, { executablePath: '../../../../../../../bin/sh' });
    const { recorder, effect } = run(roots.paths);
    const resolved = await Effect.runPromise(effect);

    assert.equal(resolved.executablePath, join(roots.installRoot, testArtifact.executablePath));
    // Not reused: it re-provisioned from the pinned artifact instead.
    assert.ok(recorder.calls.includes('downloadTo'));
    assert.equal(
      readEditorInstallReceipt(roots.installRoot)?.executablePath,
      testArtifact.executablePath,
    );
  } finally {
    roots.cleanup();
  }
});
