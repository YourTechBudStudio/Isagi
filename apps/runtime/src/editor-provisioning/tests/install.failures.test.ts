import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Deferred, Effect, Exit, Fiber } from 'effect';

import { EditorProvisioningFailure, provisionCodeServer } from '../install.js';
import {
  pinnedVersion,
  recordingInstallIo,
  testArtifact,
  type InstallIoBehaviour,
} from './test-support.js';

function makeRoots() {
  const root = mkdtempSync(join(tmpdir(), 'isagi-editor-failure-'));
  return {
    root,
    paths: { toolsPath: join(root, 'tools'), editorsPath: join(root, 'editors') },
    installRoot: join(root, 'tools', 'code-server', pinnedVersion),
    stagingRoot: join(root, 'tools', '.staging'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Empty is the same fact as absent: no attempt left scratch behind. */
function stagingEntries(stagingRoot: string) {
  return existsSync(stagingRoot) ? readdirSync(stagingRoot) : [];
}

async function provisionExpectingFailure(
  roots: ReturnType<typeof makeRoots>,
  behaviour: InstallIoBehaviour,
) {
  const recorder = recordingInstallIo(behaviour);
  const exit = await Effect.runPromiseExit(
    provisionCodeServer({
      io: recorder.io,
      paths: roots.paths,
      artifact: testArtifact,
      platformKey: 'darwin-arm64',
      version: pinnedVersion,
      onPhase: () => Effect.void,
    }),
  );
  assert.ok(Exit.isFailure(exit), 'the attempt failed');
  const failure = Exit.isFailure(exit) ? exit.cause : null;
  const error = failure && failure._tag === 'Fail' ? failure.error : null;
  assert.ok(error instanceof EditorProvisioningFailure, 'it failed with a modelled reason');
  return error;
}

const failureCases = [
  {
    name: 'a withdrawn release',
    behaviour: { downloadFailure: { status: 404 } },
    reason: 'release_unavailable',
  },
  {
    name: 'a gone release',
    behaviour: { downloadFailure: { status: 410 } },
    reason: 'release_unavailable',
  },
  {
    name: 'a server error',
    behaviour: { downloadFailure: { status: 500 } },
    reason: 'download_failed',
  },
  {
    name: 'a transport fault',
    behaviour: { downloadFailure: { status: null } },
    reason: 'download_failed',
  },
  {
    name: 'a digest mismatch',
    behaviour: { downloadedSha256: 'a'.repeat(64) },
    reason: 'integrity_mismatch',
  },
  {
    name: 'an extractor failure',
    behaviour: { extractFailure: { output: 'tar: unexpected end of file' } },
    reason: 'extract_failed',
  },
  {
    name: 'an archive with no executable',
    behaviour: { extractWithoutExecutable: true },
    reason: 'install_unusable',
  },
  {
    name: 'unpreparable shared editor state',
    behaviour: { prepareEditorStateFails: true },
    reason: 'install_unusable',
  },
] as const satisfies readonly {
  name: string;
  behaviour: InstallIoBehaviour;
  reason: string;
}[];

test('every modelled failure reports its own reason and leaves no staging behind', async () => {
  for (const item of failureCases) {
    const roots = makeRoots();
    try {
      const error = await provisionExpectingFailure(roots, item.behaviour);
      assert.equal(error.reason, item.reason, item.name);
      assert.deepEqual(stagingEntries(roots.stagingRoot), [], `${item.name} cleans up staging`);
    } finally {
      roots.cleanup();
    }
  }
});

test('a digest mismatch never creates an install root', async () => {
  const roots = makeRoots();
  try {
    const error = await provisionExpectingFailure(roots, { downloadedSha256: 'a'.repeat(64) });
    assert.equal(error.reason, 'integrity_mismatch');
    // Unverified bytes must never reach the install root, not even unpublished.
    assert.ok(!existsSync(roots.installRoot));
    // The diagnostic names both digests, which is what makes a mismatch report
    // actionable rather than merely alarming.
    assert.ok(error.diagnostic?.includes(testArtifact.sha256));
    assert.ok(error.diagnostic?.includes('a'.repeat(64)));
  } finally {
    roots.cleanup();
  }
});

test('an extraction failure carries the extractor output it was given', async () => {
  const roots = makeRoots();
  try {
    const error = await provisionExpectingFailure(roots, {
      extractFailure: { output: 'tar: unexpected end of file' },
    });
    assert.ok(error.diagnostic?.includes('tar: unexpected end of file'));
  } finally {
    roots.cleanup();
  }
});

test('failure diagnostics name the stage without echoing foreign error text', async () => {
  const roots = makeRoots();
  try {
    const withStatus = await provisionExpectingFailure(roots, {
      downloadFailure: { status: 503 },
    });
    assert.ok(withStatus.diagnostic?.includes('503'));
    assert.ok(withStatus.diagnostic?.includes(pinnedVersion));
    // `download failed` is the fake's own Error message. A diagnostic that
    // echoed it would be publishing foreign text into a user-visible field.
    assert.ok(!withStatus.diagnostic?.includes('download failed'));
  } finally {
    roots.cleanup();
  }
});

test('an interrupted attempt settles without leaving staging behind', async () => {
  const roots = makeRoots();
  try {
    const recorder = recordingInstallIo();
    // The whole scenario runs inside one fiber: forking from a `runPromise`
    // whose root fiber then completes would tear the child down before it ever
    // reached the staged region, and the assertions would pass vacuously.
    await Effect.runPromise(
      Effect.gen(function* () {
        const reachedDownload = yield* Deferred.make<void>();
        const blockForever = yield* Deferred.make<void>();
        const io = {
          ...recorder.io,
          // Holds the attempt open inside the staged region, so the interrupt
          // lands exactly where the attempt deadline would.
          downloadTo: () =>
            Effect.zipRight(
              Deferred.succeed(reachedDownload, undefined),
              Effect.zipRight(Deferred.await(blockForever), Effect.succeed({ sha256: '' })),
            ),
        };

        const fiber = yield* Effect.fork(
          provisionCodeServer({
            io,
            paths: roots.paths,
            artifact: testArtifact,
            platformKey: 'darwin-arm64',
            version: pinnedVersion,
            onPhase: () => Effect.void,
          }),
        );
        yield* Deferred.await(reachedDownload);
        // Staging exists while the attempt owns it — otherwise the assertion
        // after the interrupt would pass for the wrong reason.
        assert.equal(stagingEntries(roots.stagingRoot).length, 1);

        const exit = yield* Fiber.interrupt(fiber);
        assert.ok(Exit.isInterrupted(exit));
      }),
    );

    assert.deepEqual(stagingEntries(roots.stagingRoot), []);
    assert.ok(!existsSync(roots.installRoot));
  } finally {
    roots.cleanup();
  }
});

test('a successful attempt also removes its staging directory', async () => {
  const roots = makeRoots();
  try {
    const recorder = recordingInstallIo();
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
    assert.deepEqual(stagingEntries(roots.stagingRoot), []);
  } finally {
    roots.cleanup();
  }
});
