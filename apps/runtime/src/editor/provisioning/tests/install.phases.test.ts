import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Effect } from 'effect';

import { provisionCodeServer, type EditorInstallPhase } from '../install.js';
import { editorInstallReceiptPath } from '../receipt.js';
import {
  pinnedVersion,
  recordingInstallIo,
  testArtifact,
  writeExecutable,
} from './test-support.js';

function makeRoots() {
  const root = mkdtempSync(join(tmpdir(), 'isagi-editor-phases-'));
  return {
    root,
    paths: { toolsPath: join(root, 'tools'), editorsPath: join(root, 'editors') },
    installRoot: join(root, 'tools', 'code-server', pinnedVersion),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function provision(
  roots: ReturnType<typeof makeRoots>,
  phases: EditorInstallPhase[],
  behaviour = {},
) {
  const recorder = recordingInstallIo(behaviour);
  return provisionCodeServer({
    io: recorder.io,
    paths: roots.paths,
    artifact: testArtifact,
    platformKey: 'darwin-arm64',
    version: pinnedVersion,
    onPhase: (phase) =>
      Effect.sync(() => {
        phases.push(phase);
      }),
  });
}

// The service turns each of these into a projected state, so this is where the
// published `downloading → verifying → extracting` order is actually pinned.
// `verifying` performs no IO, which is why it cannot be observed from a
// substituted IO seam and is asserted here instead.
test('a full provision reports its phases in order, exactly once each', async () => {
  const roots = makeRoots();
  try {
    const phases: EditorInstallPhase[] = [];
    await Effect.runPromise(provision(roots, phases));
    assert.deepEqual(phases, ['downloading', 'verifying', 'extracting']);
  } finally {
    roots.cleanup();
  }
});

test('the reuse fast path reports no phases at all', async () => {
  const roots = makeRoots();
  try {
    writeExecutable(join(roots.installRoot, testArtifact.executablePath));
    writeFileSync(
      editorInstallReceiptPath(roots.installRoot),
      JSON.stringify({
        receiptVersion: 1,
        version: pinnedVersion,
        platformKey: 'darwin-arm64',
        artifactSha256: testArtifact.sha256,
        executablePath: testArtifact.executablePath,
        completedAt: '2026-08-31T00:00:00.000Z',
      }),
    );

    const phases: EditorInstallPhase[] = [];
    await Effect.runPromise(provision(roots, phases));
    // Nothing was downloaded, hashed, or extracted, so announcing any of those
    // would be a progress report for work that never happened.
    assert.deepEqual(phases, []);
  } finally {
    roots.cleanup();
  }
});

test('a failure stops the phase sequence where it happened', async () => {
  const roots = makeRoots();
  try {
    const phases: EditorInstallPhase[] = [];
    await Effect.runPromiseExit(provision(roots, phases, { downloadedSha256: 'b'.repeat(64) }));
    // Verification failed, so extraction is never announced.
    assert.deepEqual(phases, ['downloading', 'verifying']);
  } finally {
    roots.cleanup();
  }
});
