import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import test from 'node:test';

import { aggregateRelease } from './aggregate-release.mjs';
import {
  publishedAssetRecords,
  readAndVerifyReleaseManifest,
  releaseManifestName,
  serializeReleaseManifest,
  validatePlatformDirectory,
} from './artifact-manifest.mjs';
import { finalizeRelease } from './finalize-release.mjs';
import {
  assertClosedReleaseAssets,
  assertPromotedRelease,
  assertStagedRelease,
  compareReleaseAssets,
  createGitHubAdapter,
} from './github-release.mjs';
import {
  assertStrictlyIncreasing,
  classifyPipelineReleaseState,
  createPreflightAdapters,
  formatPreflightSummary,
  preflightRelease,
  runCommand,
} from './preflight.mjs';
import { reconcileRelease } from './reconcile-release.mjs';

const testCommitSha = 'a'.repeat(40);

test('release preflight centralizes ignored and stable classification facts', async () => {
  let stableChecks = 0;
  const adapters = {
    assertMainAncestor: async () => (stableChecks += 1),
    listReleases: async () => [stagedPrerelease()],
    resolveRemoteTag: async () => testCommitSha,
    verifyVersions: async () => ({ version: '1.2.3' }),
  };
  assert.deepEqual(
    await preflightRelease({
      adapters,
      commitSha: testCommitSha,
      repoRoot: '/repo',
      tag: 'v1.2.3-rc.1',
    }),
    {
      commitSha: testCommitSha,
      kind: 'prerelease_ignored',
      tag: 'v1.2.3-rc.1',
      version: '1.2.3-rc.1',
    },
  );
  assert.equal(stableChecks, 0);
  assert.deepEqual(
    await preflightRelease({
      adapters,
      commitSha: testCommitSha,
      repoRoot: '/repo',
      tag: 'v1.2.3',
    }),
    {
      commitSha: testCommitSha,
      kind: 'stable_release',
      releaseState: 'staged',
      tag: 'v1.2.3',
      version: '1.2.3',
    },
  );
  assert.equal(stableChecks, 1);
});

test('release preflight re-enters only a stable release a previous run already promoted', async () => {
  const withRelease = (release) => ({
    assertMainAncestor: async () => undefined,
    listReleases: async () => [release],
    resolveRemoteTag: async () => testCommitSha,
    verifyVersions: async () => ({ version: '1.2.3' }),
  });
  const promoted = {
    ...stagedPrerelease(),
    assets: [{ name: releaseManifestName }],
    prerelease: false,
  };
  const result = await preflightRelease({
    adapters: withRelease(promoted),
    commitSha: testCommitSha,
    repoRoot: '/repo',
    tag: 'v1.2.3',
  });
  assert.equal(result.releaseState, 'promoted');
  assert.match(
    formatPreflightSummary({ result }),
    /Release state: `promoted` \(reconciling a release a previous run already promoted\)/u,
  );

  // A stable release published by hand carries no manifest and must never start the pipeline.
  await assert.rejects(
    preflightRelease({
      adapters: withRelease({ ...promoted, assets: [{ name: 'notes.txt' }] }),
      commitSha: testCommitSha,
      repoRoot: '/repo',
      tag: 'v1.2.3',
    }),
    /already stable but carries no release-manifest\.json/u,
  );
  await assert.rejects(
    preflightRelease({
      adapters: withRelease({ ...promoted, assets: undefined }),
      commitSha: testCommitSha,
      repoRoot: '/repo',
      tag: 'v1.2.3',
    }),
    /already stable but carries no release-manifest\.json/u,
  );
});

test('release preflight rejects malformed, moved, drifting, and non-increasing releases', async () => {
  const base = {
    assertMainAncestor: async () => undefined,
    listReleases: async () => [stagedPrerelease()],
    resolveRemoteTag: async () => testCommitSha,
    verifyVersions: async () => ({ version: '1.2.3' }),
  };
  await assert.rejects(
    preflightRelease({
      adapters: base,
      commitSha: testCommitSha,
      repoRoot: '/repo',
      tag: 'v01.2.3',
    }),
    /not a supported release tag/u,
  );
  await assert.rejects(
    preflightRelease({
      adapters: { ...base, verifyVersions: async () => ({ version: '1.2.2' }) },
      commitSha: testCommitSha,
      repoRoot: '/repo',
      tag: 'v1.2.3',
    }),
    /does not match synchronized/u,
  );
  await assert.rejects(
    preflightRelease({
      adapters: { ...base, resolveRemoteTag: async () => 'moved' },
      commitSha: testCommitSha,
      repoRoot: '/repo',
      tag: 'v1.2.3',
    }),
    /resolves to moved/u,
  );
  await assert.rejects(
    preflightRelease({
      adapters: { ...base, listReleases: async () => [] },
      commitSha: testCommitSha,
      repoRoot: '/repo',
      tag: 'v1.2.3',
    }),
    /Published GitHub release v1\.2\.3 is required/u,
  );
  assert.throws(
    () => classifyPipelineReleaseState('v1.2.3', [{ ...stagedPrerelease(), draft: true }]),
    /still a draft; publish it as a prerelease/u,
  );
  assert.equal(classifyPipelineReleaseState('v1.2.3', [stagedPrerelease()]), 'staged');
  assert.throws(
    () =>
      assertStrictlyIncreasing('1.2.3', 'v1.2.3', [
        { draft: false, prerelease: false, tag_name: 'v1.2.4' },
      ]),
    /not greater/u,
  );
  assert.doesNotThrow(() =>
    assertStrictlyIncreasing('1.2.3', 'v1.2.3', [
      { draft: false, prerelease: false, tag_name: 'v1.2.3' },
      { draft: true, prerelease: false, tag_name: 'v9.0.0' },
      { draft: false, prerelease: true, tag_name: 'v9.0.0' },
      { draft: false, prerelease: false, tag_name: 'v1.2.2' },
    ]),
  );
});

test('preflight adapters and summaries make attempted-release failures actionable', async () => {
  const adapterFailingWith = (failure) =>
    createPreflightAdapters({
      repository: 'owner/repo',
      run: async () => {
        throw failure;
      },
    });
  await assert.rejects(
    adapterFailingWith(
      Object.assign(new Error('git merge-base failed (exit 1): '), { exitCode: 1 }),
    ).assertMainAncestor(testCommitSha),
    /is not reachable from origin\/main/u,
  );
  await assert.rejects(
    adapterFailingWith(
      Object.assign(new Error('git merge-base failed (exit 128): bad object'), { exitCode: 128 }),
    ).assertMainAncestor(testCommitSha),
    /could not be completed: .*exit 128.*bad object/u,
  );
  await assert.rejects(
    adapterFailingWith(new Error('spawn git ENOENT')).assertMainAncestor(testCommitSha),
    /could not be completed: spawn git ENOENT/u,
  );
  assert.equal(
    formatPreflightSummary({
      commitSha: testCommitSha,
      error: new Error('Version drift.'),
      tag: 'v1.2.3',
    }),
    `## Release classification failed\n\n- Tag: \`v1.2.3\`\n- Commit: \`${testCommitSha}\`\n- Reason: Version drift.\n`,
  );
});

test('runCommand preserves the exit status that classifies a command failure', async () => {
  await assert.rejects(
    runCommand(process.execPath, ['-e', 'process.exit(128)']),
    (error) => error.exitCode === 128 && /exit 128/u.test(error.message),
  );
  await assert.rejects(
    runCommand('isagi-command-that-does-not-exist', []),
    (error) => error.exitCode === undefined && error.code === 'ENOENT',
  );
});

test('aggregation validates isolated platform inputs and recomputes the closed manifest', () => {
  const fixture = createAggregateFixture();
  try {
    const manifest = aggregateRelease(fixture.options);
    assert.equal(manifest.assets.length, 8);
    assert.deepEqual(
      readAndVerifyReleaseManifest(fixture.output, {
        commitSha: testCommitSha,
        tag: 'v1.2.3',
        version: '1.2.3',
      }),
      manifest,
    );
    assert.match(
      readFileSync(resolve(fixture.output, 'latest-mac.yml'), 'utf8'),
      /Isagi-mac-arm64/u,
    );
    const unsupported = { ...manifest, note: 'not part of schema' };
    writeFileSync(resolve(fixture.output, releaseManifestName), serializeReleaseManifest(manifest));
    assert.throws(() => serializeReleaseManifest(unsupported), /unsupported top-level fields/u);
    assert.throws(
      () => serializeReleaseManifest({ ...manifest, tag: 'v1.2.4' }),
      /do not identify the same stable release/u,
    );
    assert.throws(
      () => serializeReleaseManifest({ ...manifest, commitSha: 'abc123' }),
      /not a full Git commit SHA/u,
    );
    writeFileSync(resolve(fixture.output, 'Isagi-mac-arm64.zip'), 'tampered');
    assert.throws(
      () => readAndVerifyReleaseManifest(fixture.output),
      /does not match its declared size and SHA-256/u,
    );
  } finally {
    fixture.cleanup();
  }
});

test('platform artifact validation rejects missing, unexpected, and symlink-shaped handoffs', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'isagi-release-platform-'));
  try {
    for (const name of [
      'Isagi-linux-x86_64.AppImage',
      'install-isagi-linux.sh',
      'latest-linux.yml',
    ]) {
      writeFileSync(resolve(root, name), name);
    }
    assert.equal(validatePlatformDirectory(root, 'linux').length, 3);
    writeFileSync(resolve(root, 'unexpected'), 'no');
    assert.throws(() => validatePlatformDirectory(root, 'linux'), /unexpected entry/u);
    rmSync(resolve(root, 'unexpected'));
    rmSync(resolve(root, 'latest-linux.yml'));
    assert.throws(() => validatePlatformDirectory(root, 'linux'), /missing latest-linux/u);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('the promotion gate requires the remote assets to be exactly the validated set', () => {
  const expected = [{ name: 'asset', sha256: 'a'.repeat(64), size: 3 }];
  const exact = [{ digest: `sha256:${'a'.repeat(64)}`, id: 1, name: 'asset', size: 3 }];
  const gate = (remote) => () =>
    assertClosedReleaseAssets(compareReleaseAssets(remote, expected), 'v1.2.3');
  assert.deepEqual(compareReleaseAssets([], expected).missing, ['asset']);
  assert.deepEqual(compareReleaseAssets([{ ...exact[0], size: 4 }], expected).mismatched, [
    'asset',
  ]);
  assert.deepEqual(compareReleaseAssets([...exact, { name: 'notes.txt' }], expected).unexpected, [
    'notes.txt',
  ]);
  assert.doesNotThrow(gate(exact));
  assert.throws(gate([]), /\(missing asset\)/u);
  assert.throws(gate([{ ...exact[0], size: 4 }]), /\(mismatched asset\)/u);
  // An unverified file attached by hand must block promotion rather than ride along with it.
  assert.throws(gate([...exact, { name: 'notes.txt' }]), /\(unexpected notes\.txt\)/u);
  assert.throws(gate([{ name: 'notes.txt' }]), /\(missing asset; unexpected notes\.txt\)/u);
});

test('only a staged prerelease is writable and only a stable release is reconcilable', () => {
  assert.throws(() => assertStagedRelease(undefined, 'v1.2.3'), /does not exist/u);
  assert.throws(
    () => assertStagedRelease({ draft: true, prerelease: true }, 'v1.2.3'),
    /must be published before its assets can be attached/u,
  );
  assert.throws(
    () => assertStagedRelease({ draft: false, prerelease: false }, 'v1.2.3'),
    /already stable and must not be rewritten/u,
  );
  // Only "Re-run all jobs" reruns classification, so only it can reach the read-only verification
  // job. The failure a maintainer actually sees has to say that, or they retry into a loop.
  assert.throws(
    () => assertStagedRelease({ draft: false, prerelease: false }, 'v1.2.3'),
    /recover with GitHub's "Re-run all jobs".+"Re-run failed jobs" reuses the stale classification/su,
  );
  assert.doesNotThrow(() => assertStagedRelease({ draft: false, prerelease: true }, 'v1.2.3'));

  assert.throws(() => assertPromotedRelease(undefined, 'v1.2.3'), /does not exist/u);
  assert.throws(
    () => assertPromotedRelease({ draft: false, prerelease: true }, 'v1.2.3'),
    /is not a promoted stable release/u,
  );
  assert.doesNotThrow(() => assertPromotedRelease({ draft: false, prerelease: false }, 'v1.2.3'));
});

test('GitHub adapter clobbers only on request and promotes with an explicit latest flag', async () => {
  const calls = [];
  const adapter = createGitHubAdapter({
    run: async (command, args) => {
      calls.push([command, ...args]);
      return { stdout: '' };
    },
  });
  await adapter.uploadAssets('owner/repo', 'v1.2.3', ['/tmp/asset-one'], { clobber: false });
  await adapter.uploadAssets('owner/repo', 'v1.2.3', ['/tmp/asset-two'], { clobber: true });
  await adapter.promoteToStable('owner/repo', 'v1.2.3');
  assert.deepEqual(calls, [
    ['gh', 'release', 'upload', 'v1.2.3', '/tmp/asset-one', '--repo', 'owner/repo'],
    ['gh', 'release', 'upload', 'v1.2.3', '/tmp/asset-two', '--clobber', '--repo', 'owner/repo'],
    [
      'gh',
      'release',
      'edit',
      'v1.2.3',
      '--prerelease=false',
      '--latest=true',
      '--repo',
      'owner/repo',
    ],
  ]);
});

test('release finalization uploads the validated set and promotes only after verifying it', async () => {
  const fixture = createAggregateFixture();
  try {
    const manifest = aggregateRelease(fixture.options);
    const expected = publishedAssetRecords(manifest);
    const state = stagedState();
    const result = await finalizeRelease({
      adapter: createFakeReleaseAdapter(state, expected),
      commitSha: testCommitSha,
      directory: fixture.output,
      repository: 'owner/repo',
      tag: 'v1.2.3',
      version: '1.2.3',
    });
    assert.equal(result.assetCount, expected.length);
    assert.deepEqual(result.uploaded, expected.map((asset) => asset.name).sort());
    assert.deepEqual(state.calls, [
      'resolve-tag',
      'get-release',
      `upload:fresh:${expected.length}`,
      'resolve-tag',
      'get-release',
      'promote',
      'get-release',
    ]);
    assert.equal(state.release.prerelease, false);

    // An asset the pipeline did not validate blocks promotion instead of shipping alongside it.
    const contaminated = stagedState([{ id: 1, name: 'notes.txt' }]);
    await assert.rejects(
      finalizeRelease({
        adapter: createFakeReleaseAdapter(contaminated, expected),
        commitSha: testCommitSha,
        directory: fixture.output,
        repository: 'owner/repo',
        tag: 'v1.2.3',
        version: '1.2.3',
      }),
      /\(unexpected notes\.txt\)/u,
    );
    assert.equal(contaminated.calls.includes('promote'), false);
    assert.equal(contaminated.release.prerelease, true);

    writeFileSync(resolve(fixture.output, 'unexpected'), 'no');
    const blocked = stagedState();
    await assert.rejects(
      finalizeRelease({
        adapter: createFakeReleaseAdapter(blocked, expected),
        commitSha: testCommitSha,
        directory: fixture.output,
        repository: 'owner/repo',
        tag: 'v1.2.3',
        version: '1.2.3',
      }),
      /differs from the closed release manifest/u,
    );
    assert.deepEqual(blocked.calls, []);
  } finally {
    fixture.cleanup();
  }
});

test('release finalization reruns without clobbering assets that are already correct', async () => {
  const fixture = createAggregateFixture();
  try {
    const manifest = aggregateRelease(fixture.options);
    const expected = publishedAssetRecords(manifest);
    const [damaged, absent, ...intact] = expected;

    // A rerun after a partially completed upload must touch exactly the broken assets.
    const partial = stagedState(
      intact.map(remoteAsset).concat({ ...remoteAsset(damaged), size: damaged.size + 1 }),
    );
    const partialResult = await finalizeRelease({
      adapter: createFakeReleaseAdapter(partial, expected),
      commitSha: testCommitSha,
      directory: fixture.output,
      repository: 'owner/repo',
      tag: 'v1.2.3',
      version: '1.2.3',
    });
    assert.deepEqual(partialResult.uploaded, [absent.name, damaged.name].sort());
    assert.deepEqual(partial.calls, [
      'resolve-tag',
      'get-release',
      'upload:fresh:1',
      'upload:clobber:1',
      'resolve-tag',
      'get-release',
      'promote',
      'get-release',
    ]);

    // A rerun against a complete asset set uploads nothing at all.
    const complete = stagedState(expected.map(remoteAsset));
    const completeResult = await finalizeRelease({
      adapter: createFakeReleaseAdapter(complete, expected),
      commitSha: testCommitSha,
      directory: fixture.output,
      repository: 'owner/repo',
      tag: 'v1.2.3',
      version: '1.2.3',
    });
    assert.deepEqual(completeResult.uploaded, []);
    assert.deepEqual(complete.calls, [
      'resolve-tag',
      'get-release',
      'resolve-tag',
      'get-release',
      'promote',
      'get-release',
    ]);
  } finally {
    fixture.cleanup();
  }
});

test('release finalization refuses missing or unpublished releases', async () => {
  const fixture = createAggregateFixture();
  try {
    const manifest = aggregateRelease(fixture.options);
    const expected = publishedAssetRecords(manifest);
    for (const release of [undefined, { assets: [], draft: true, id: 42, prerelease: true }]) {
      const state = { calls: [], release };
      await assert.rejects(
        finalizeRelease({
          adapter: createFakeReleaseAdapter(state, expected),
          commitSha: testCommitSha,
          directory: fixture.output,
          repository: 'owner/repo',
          tag: 'v1.2.3',
          version: '1.2.3',
        }),
        /does not exist|must be published before its assets/u,
      );
      assert.deepEqual(state.calls, ['resolve-tag', 'get-release']);
    }
  } finally {
    fixture.cleanup();
  }
});

test('a differing rebuild can never replace or remove an asset on a promoted release', async () => {
  const original = createAggregateFixture();
  const rebuilt = createAggregateFixture({ rebuild: true });
  try {
    const manifest = aggregateRelease(original.options);
    const published = publishedAssetRecords(manifest);
    const rebuiltManifest = aggregateRelease(rebuilt.options);
    const rebuiltAssets = publishedAssetRecords(rebuiltManifest);
    // The premise: a later build of the same commit does not reproduce the original bytes.
    assert.notDeepEqual(
      rebuiltAssets.map((asset) => asset.sha256),
      published.map((asset) => asset.sha256),
    );

    // GitHub applies the promotion, then the run fails before it can confirm it.
    const interrupted = stagedState();
    const interruptedAdapter = createFakeReleaseAdapter(interrupted, published);
    const promote = interruptedAdapter.promoteToStable;
    interruptedAdapter.promoteToStable = async (...args) => {
      await promote(...args);
      throw new Error('gh: connection reset by peer');
    };
    await assert.rejects(
      finalizeRelease({
        adapter: interruptedAdapter,
        commitSha: testCommitSha,
        directory: original.output,
        repository: 'owner/repo',
        tag: 'v1.2.3',
        version: '1.2.3',
      }),
      /connection reset by peer/u,
    );
    const stable = interrupted.release;
    assert.equal(stable.prerelease, false);

    // Preflight routes that release to reconciliation, never back through finalization.
    assert.equal(
      classifyPipelineReleaseState('v1.2.3', [{ ...stable, tag_name: 'v1.2.3' }]),
      'promoted',
    );

    // Even handed the rebuilt aggregate, finalization refuses to write to a stable release.
    const attempted = { calls: [], release: stable };
    await assert.rejects(
      finalizeRelease({
        adapter: createFakeReleaseAdapter(attempted, rebuiltAssets),
        commitSha: testCommitSha,
        directory: rebuilt.output,
        repository: 'owner/repo',
        tag: 'v1.2.3',
        version: '1.2.3',
      }),
      /already stable and must not be rewritten/u,
    );
    assert.deepEqual(attempted.calls, ['resolve-tag', 'get-release']);

    // Reconciliation proves the release against the manifest the original run attached, and the
    // rebuilt bytes never enter the comparison.
    const reconciled = { calls: [], release: stable };
    const result = await reconcileRelease({
      adapter: createFakeReleaseAdapter(reconciled, published),
      commitSha: testCommitSha,
      repository: 'owner/repo',
      tag: 'v1.2.3',
      version: '1.2.3',
    });
    assert.equal(result.assetCount, published.length);
    assert.deepEqual(reconciled.calls, ['resolve-tag', 'get-release', 'download-manifest']);
    assert.deepEqual(stable.assets, interrupted.release.assets);
  } finally {
    original.cleanup();
    rebuilt.cleanup();
  }
});

test('reconciliation rejects a promoted release that diverges from its attached manifest', async () => {
  const fixture = createAggregateFixture();
  try {
    const manifest = aggregateRelease(fixture.options);
    const published = publishedAssetRecords(manifest);
    const promoted = (assets) => ({
      calls: [],
      release: { ...stagedPrerelease(), assets, id: 42, prerelease: false },
    });
    const reconcile = (state, options) =>
      reconcileRelease({
        adapter: createFakeReleaseAdapter(state, published, options),
        commitSha: testCommitSha,
        repository: 'owner/repo',
        tag: 'v1.2.3',
        version: '1.2.3',
      });

    await assert.rejects(
      reconcile(promoted(published.slice(1).map(remoteAsset))),
      /does not hold exactly the validated asset set \(missing /u,
    );
    await assert.rejects(
      reconcile(promoted([...published.map(remoteAsset), { name: 'notes.txt' }])),
      /\(unexpected notes\.txt\)/u,
    );
    await assert.rejects(
      reconcile(promoted(published.map(remoteAsset)), { manifestText: '{"schemaVersion":1}\n' }),
      /Unsupported release manifest|contains unsupported top-level fields/u,
    );
    await assert.rejects(
      reconcile(promoted(published.map(remoteAsset)), { manifestText: 'not json' }),
      /unreadable release-manifest\.json/u,
    );
    // Canonical content, non-canonical bytes: not something a pipeline run wrote.
    await assert.rejects(
      reconcile(promoted(published.map(remoteAsset)), {
        manifestText: JSON.stringify(manifest),
      }),
      /release-manifest\.json the pipeline did not write/u,
    );

    // A stable release is only ever read.
    const state = promoted(published.map(remoteAsset));
    await reconcile(state);
    assert.equal(
      state.calls.some((call) => call.startsWith('upload') || call === 'promote'),
      false,
    );
  } finally {
    fixture.cleanup();
  }
});

test('release finalization leaves a prerelease behind when uploads or identity fail', async () => {
  const fixture = createAggregateFixture();
  try {
    const manifest = aggregateRelease(fixture.options);
    const expected = publishedAssetRecords(manifest);
    const incomplete = stagedState();
    const incompleteAdapter = createFakeReleaseAdapter(incomplete, expected);
    incompleteAdapter.uploadAssets = async () => incomplete.calls.push('upload-without-assets');
    await assert.rejects(
      finalizeRelease({
        adapter: incompleteAdapter,
        commitSha: testCommitSha,
        directory: fixture.output,
        repository: 'owner/repo',
        tag: 'v1.2.3',
        version: '1.2.3',
      }),
      /does not hold exactly the validated asset set \(missing .+\)/u,
    );
    assert.equal(incomplete.calls.includes('promote'), false);
    assert.equal(incomplete.release.prerelease, true);

    const replaced = stagedState();
    const replacedAdapter = createFakeReleaseAdapter(replaced, expected);
    const originalGetRelease = replacedAdapter.getRelease;
    let reads = 0;
    replacedAdapter.getRelease = async (...args) => {
      const release = await originalGetRelease(...args);
      reads += 1;
      return reads === 2 ? { ...release, id: 43 } : release;
    };
    await assert.rejects(
      finalizeRelease({
        adapter: replacedAdapter,
        commitSha: testCommitSha,
        directory: fixture.output,
        repository: 'owner/repo',
        tag: 'v1.2.3',
        version: '1.2.3',
      }),
      /changed identity/u,
    );
    assert.equal(replaced.calls.includes('promote'), false);
  } finally {
    fixture.cleanup();
  }
});

test('release finalization refuses a moved tag before touching the staged release', async () => {
  const fixture = createAggregateFixture();
  try {
    const manifest = aggregateRelease(fixture.options);
    const expected = publishedAssetRecords(manifest);
    const state = stagedState();
    const adapter = createFakeReleaseAdapter(state, expected);
    adapter.resolveRemoteTag = async () => {
      state.calls.push('resolve-tag');
      return 'b'.repeat(40);
    };
    await assert.rejects(
      finalizeRelease({
        adapter,
        commitSha: testCommitSha,
        directory: fixture.output,
        repository: 'owner/repo',
        tag: 'v1.2.3',
        version: '1.2.3',
      }),
      /Remote tag v1\.2\.3 moved/u,
    );
    assert.deepEqual(state.calls, ['resolve-tag']);
  } finally {
    fixture.cleanup();
  }
});

test('release workflow pins actions, scopes signing secrets, binds production, and preserves gate dependencies', () => {
  const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
  for (const use of workflow.matchAll(/uses:\s+([^\s#]+)/gu)) {
    assert.match(use[1], /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/u);
  }
  assert.match(workflow, /on:\n  release:\n    types: \[published\]/u);
  assert.doesNotMatch(workflow, /push:\n    tags:/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.doesNotMatch(workflow, /if:\s*always\(\)/u);
  assert.match(workflow, /runs-on: macos-15\n/u);
  assert.match(workflow, /runs-on: macos-15-intel/u);
  assert.equal(workflow.match(/^    environment: Production$/gmu)?.length, 3);
  assert.match(
    workflow,
    /mac_arm64:\n    name: macOS arm64\n    needs: \[classify\]\n    if: .+\n    environment: Production\n    runs-on: macos-15\n/u,
  );
  assert.match(
    workflow,
    /mac_x64:\n    name: macOS x64\n    needs: \[classify\]\n    if: .+\n    environment: Production\n    runs-on: macos-15-intel\n/u,
  );
  assert.equal(workflow.match(/secrets\.APPLE_ID/gu)?.length, 2);
  assert.equal(workflow.match(/secrets\./gu)?.length, 12);
  const packagingSteps = workflow.match(
    /      - name: Build and verify macOS (?:arm64|x64)\n        env:\n(?:          .+\n)+        run: pnpm package:desktop:mac -- --(?:arm64|x64)/gu,
  );
  assert.equal(packagingSteps?.length, 2);
  assert.doesNotMatch(
    packagingSteps.reduce((remaining, step) => remaining.replace(step, ''), workflow),
    /secrets\./u,
  );
  // Only the job that writes to a staged prerelease may hold write permission. The reconcile job
  // deliberately keeps the workflow's default read permission, so it cannot alter a stable release
  // even if its logic were wrong.
  assert.equal(workflow.match(/contents: write/gu)?.length, 1);
  assert.match(
    workflow,
    /finalize:\n    name: Attach assets and promote release\n    needs: \[classify, linux, mac_arm64, mac_x64\]\n    if: needs\.classify\.outputs\.releaseState == 'staged'\n    environment: Production\n(?:.+\n)*?    permissions:\n      contents: write\n/u,
  );
  // Promotion is the last thing the writing job does, so no step runs after a stable release exists.
  assert.match(
    workflow,
    /run: node scripts\/release-pipeline\/finalize-release\.mjs release-aggregate\n\n/u,
  );
  // A rerun against an already-promoted release rebuilds nothing: every build job is gated on the
  // staged state, so a non-reproducible rebuild can never reach a public release.
  assert.equal(
    workflow.match(
      /^    if: needs\.classify\.outputs\.kind == 'stable_release' &&\n?\s*needs\.classify\.outputs\.releaseState == 'staged'$/gmu,
    )?.length,
    3,
  );
  assert.match(
    workflow,
    /reconcile:\n    name: Verify an already-promoted release\n    needs: \[classify\]\n    if: needs\.classify\.outputs\.releaseState == 'promoted'\n/u,
  );
  const reconcileJob = workflow.slice(workflow.indexOf('\n  reconcile:'));
  assert.doesNotMatch(reconcileJob, /permissions:|environment:|secrets\.|upload-artifact/u);
  assert.doesNotMatch(workflow, /^  (?:aggregate|publish|update_release):$/gmu);
});

test('the maintainer documentation names the only rerun action that recovers a promoted release', () => {
  const guide = readFileSync(resolve('docs/development-runtime.md'), 'utf8');
  const release = guide.slice(guide.indexOf('## Release process'), guide.indexOf('## Desktop'));
  assert.match(
    release,
    /Always use GitHub's \*\*Re-run all jobs\*\*, never \*\*Re-run failed jobs\*\*/u,
  );
  assert.match(release, /\*\*Re-run failed jobs\*\* actively misleads/u);
});

// `rebuild` models a later build of the same commit. Signed macOS artifacts and the generated
// update metadata are not byte-reproducible, so a rebuild legitimately produces different bytes
// for the same release.
function createAggregateFixture({ rebuild = false } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'isagi-release-aggregate-'));
  const linux = resolve(root, 'linux');
  const x64 = resolve(root, 'mac-x64');
  const arm64 = resolve(root, 'mac-arm64');
  const output = resolve(root, 'output');
  const salt = rebuild ? '-rebuilt' : '';
  for (const directory of [linux, x64, arm64]) mkdirSync(directory, { recursive: true });
  for (const name of [
    'Isagi-linux-x86_64.AppImage',
    'install-isagi-linux.sh',
    'latest-linux.yml',
  ]) {
    writeFileSync(resolve(linux, name), `${name}${salt}`);
  }
  createMacInput(x64, 'x64', salt);
  createMacInput(arm64, 'arm64', salt);
  return {
    cleanup: () => rmSync(root, { force: true, recursive: true }),
    options: {
      commitSha: testCommitSha,
      linuxDirectory: linux,
      macArm64Directory: arm64,
      macX64Directory: x64,
      outputDirectory: output,
      tag: 'v1.2.3',
      version: '1.2.3',
    },
    output,
  };
}

function createMacInput(directory, architecture, salt = '') {
  const records = [];
  for (const extension of ['zip', 'dmg']) {
    const name = `Isagi-mac-${architecture}.${extension}`;
    const contents = Buffer.from(`${architecture}-${extension}${salt}`);
    writeFileSync(resolve(directory, name), contents);
    records.push({
      name,
      sha512: createHash('sha512').update(contents).digest('base64'),
      size: contents.length,
    });
  }
  writeFileSync(
    resolve(directory, 'latest-mac.yml'),
    `version: 1.2.3\nfiles:\n${records.map((record) => `  - url: ${record.name}\n    sha512: ${record.sha512}\n    size: ${record.size}`).join('\n')}\npath: ${records[0].name}\nsha512: ${records[0].sha512}\nreleaseDate: '2026-07-30T00:00:00.000Z'\n`,
  );
}

function stagedPrerelease() {
  return { draft: false, prerelease: true, tag_name: 'v1.2.3' };
}

function stagedState(assets = []) {
  return {
    calls: [],
    release: { ...stagedPrerelease(), assets, id: 42 },
  };
}

// The manifest orders assets the way readdirSync().sort() does, which is not the collation
// publishedAssetRecords uses for the published set.
function byCanonicalName(left, right) {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

// The manifest a completed run attached, rebuilt from the asset set it published.
function attachedManifest(expected) {
  return {
    schemaVersion: 1,
    version: '1.2.3',
    tag: 'v1.2.3',
    commitSha: testCommitSha,
    assets: expected.filter((asset) => asset.name !== releaseManifestName).sort(byCanonicalName),
  };
}

function remoteAsset(expected) {
  return {
    digest: `sha256:${expected.sha256}`,
    id: 100,
    name: expected.name,
    size: expected.size,
  };
}

// Each getRelease answer is a snapshot, so the finalizer's identity and completeness checks read
// the release as it stood at that moment rather than the fake's latest mutation.
function createFakeReleaseAdapter(state, expected, { manifestText } = {}) {
  const expectedByName = new Map(expected.map((asset) => [asset.name, asset]));
  return {
    downloadAsset: async (_repository, _tag, name) => {
      state.calls.push('download-manifest');
      assert.equal(name, releaseManifestName);
      return manifestText ?? serializeReleaseManifest(attachedManifest(expected));
    },
    getRelease: async () => {
      state.calls.push('get-release');
      return state.release;
    },
    promoteToStable: async () => {
      state.calls.push('promote');
      state.release = { ...state.release, prerelease: false };
    },
    resolveRemoteTag: async () => {
      state.calls.push('resolve-tag');
      return testCommitSha;
    },
    uploadAssets: async (_repository, _tag, paths, { clobber }) => {
      state.calls.push(`upload:${clobber ? 'clobber' : 'fresh'}:${paths.length}`);
      const uploaded = paths.map((path) => basename(path));
      const replaced = new Set(uploaded);
      state.release = {
        ...state.release,
        assets: [
          ...state.release.assets.filter((asset) => !replaced.has(asset.name)),
          ...uploaded.map((name) => remoteAsset(expectedByName.get(name))),
        ],
      };
    },
  };
}
