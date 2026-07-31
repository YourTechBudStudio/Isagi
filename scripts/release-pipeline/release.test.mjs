import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { aggregateRelease } from './aggregate-release.mjs';
import {
  publishedAssetRecords,
  readAndVerifyReleaseManifest,
  releaseManifestName,
  serializeReleaseManifest,
  validatePlatformDirectory,
} from './artifact-manifest.mjs';
import {
  assertStrictlyIncreasing,
  createPreflightAdapters,
  formatPreflightSummary,
  preflightRelease,
  runCommand,
} from './preflight.mjs';
import {
  compareRemoteAssets,
  createGitHubAdapter,
  decideReleaseAction,
  publishRelease,
} from './publish-release.mjs';

const testCommitSha = 'a'.repeat(40);

test('release preflight centralizes ignored and stable classification facts', async () => {
  let stableChecks = 0;
  const adapters = {
    assertMainAncestor: async () => (stableChecks += 1),
    listReleases: async () => [],
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
    { commitSha: testCommitSha, kind: 'stable_release', tag: 'v1.2.3', version: '1.2.3' },
  );
  assert.equal(stableChecks, 1);
});

test('release preflight rejects malformed, moved, drifting, and non-increasing releases', async () => {
  const base = {
    assertMainAncestor: async () => undefined,
    listReleases: async () => [],
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

test('publisher decisions distinguish safe retry, exact published no-op, and mismatch refusal', () => {
  const expected = [{ name: 'asset', sha256: 'a'.repeat(64), size: 3 }];
  const exact = [{ digest: `sha256:${'a'.repeat(64)}`, id: 1, name: 'asset', size: 3 }];
  assert.equal(decideReleaseAction(undefined, expected)._tag, 'create_draft');
  assert.equal(
    decideReleaseAction({ assets: exact, draft: true, prerelease: false }, expected)._tag,
    'synchronize_draft',
  );
  assert.equal(
    decideReleaseAction({ assets: exact, draft: false, prerelease: false }, expected)._tag,
    'published_noop',
  );
  assert.equal(
    decideReleaseAction(
      { assets: [{ ...exact[0], size: 4 }], draft: false, prerelease: false },
      expected,
    )._tag,
    'published_mismatch',
  );
  assert.deepEqual(compareRemoteAssets([], expected).missing, ['asset']);
  assert.equal(compareRemoteAssets([...exact, ...exact], expected).exact, false);
});

test('stable publisher rejects prerelease and malformed release state before asset comparison', () => {
  const expected = [{ name: 'asset', sha256: 'a'.repeat(64), size: 3 }];
  for (const draft of [undefined, null, 'false', 0, 1, {}]) {
    const release = { draft, prerelease: false };
    Object.defineProperty(release, 'assets', {
      get: () => {
        throw new Error('asset comparison must not run');
      },
    });
    assert.throws(
      () => decideReleaseAction(release, expected),
      /does not explicitly declare draft=true or draft=false/u,
    );
  }
  for (const prerelease of [true, undefined, null, 'false', 0]) {
    const release = { draft: true, prerelease };
    Object.defineProperty(release, 'assets', {
      get: () => {
        throw new Error('asset comparison must not run');
      },
    });
    assert.throws(
      () => decideReleaseAction(release, expected),
      /does not explicitly declare prerelease=false/u,
    );
  }
  assert.throws(
    () =>
      decideReleaseAction(
        {
          assets: [{ digest: `sha256:${'a'.repeat(64)}`, name: 'asset', size: 3 }],
          draft: false,
          prerelease: true,
        },
        expected,
      ),
    /does not explicitly declare prerelease=false/u,
  );
});

test('GitHub draft creation explicitly requests stable release state', async () => {
  const calls = [];
  const adapter = createGitHubAdapter({
    run: async (command, args) => {
      calls.push([command, ...args]);
      return { stdout: JSON.stringify({ draft: true, prerelease: false }) };
    },
  });
  await adapter.createDraft('owner/repo', {
    commitSha: 'abc123',
    tag: 'v1.2.3',
    version: '1.2.3',
  });
  assert.equal(calls[0].includes('prerelease=false'), true);
});

test('publisher validates locally before draft mutation and synchronizes only a matching draft', async () => {
  const fixture = createAggregateFixture();
  try {
    const manifest = aggregateRelease(fixture.options);
    const expected = publishedAssetRecords(manifest);
    const state = { release: undefined, calls: [] };
    const adapter = createFakePublisherAdapter(state, expected);
    const result = await publishRelease({
      adapter,
      commitSha: testCommitSha,
      directory: fixture.output,
      repository: 'owner/repo',
      tag: 'v1.2.3',
      version: '1.2.3',
    });
    assert.equal(result.action, 'published');
    assert.equal(state.calls[0], 'resolve-tag');
    assert.equal(state.calls.at(-2), 'resolve-tag');
    assert.equal(state.calls.at(-1), 'publish');

    writeFileSync(resolve(fixture.output, 'unexpected'), 'no');
    const blocked = { release: undefined, calls: [] };
    await assert.rejects(
      publishRelease({
        adapter: createFakePublisherAdapter(blocked, expected),
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

test('publisher retries a draft but never modifies a mismatched published release', async () => {
  const fixture = createAggregateFixture();
  try {
    const manifest = aggregateRelease(fixture.options);
    const expected = publishedAssetRecords(manifest);
    const matching = expected[0];
    const draftState = {
      calls: [],
      release: {
        assets: [
          {
            digest: `sha256:${matching.sha256}`,
            id: 1,
            name: matching.name,
            size: matching.size,
          },
          { digest: `sha256:${'0'.repeat(64)}`, id: 2, name: expected[1].name, size: 0 },
          { digest: `sha256:${'0'.repeat(64)}`, id: 3, name: 'foreign', size: 1 },
        ],
        draft: true,
        id: 42,
        prerelease: false,
      },
    };
    const retried = await publishRelease({
      adapter: createFakePublisherAdapter(draftState, expected),
      commitSha: testCommitSha,
      directory: fixture.output,
      repository: 'owner/repo',
      tag: 'v1.2.3',
      version: '1.2.3',
    });
    assert.equal(retried.action, 'published');
    assert.equal(draftState.calls.filter((call) => call.startsWith('delete:')).length, 2);

    const publishedState = {
      calls: [],
      release: {
        assets: [{ digest: `sha256:${'0'.repeat(64)}`, id: 1, name: matching.name, size: 0 }],
        draft: false,
        id: 43,
        prerelease: false,
      },
    };
    await assert.rejects(
      publishRelease({
        adapter: createFakePublisherAdapter(publishedState, expected),
        commitSha: testCommitSha,
        directory: fixture.output,
        repository: 'owner/repo',
        tag: 'v1.2.3',
        version: '1.2.3',
      }),
      /refusing to modify it/u,
    );
    assert.deepEqual(publishedState.calls, ['resolve-tag']);
  } finally {
    fixture.cleanup();
  }
});

test('publisher fails without retry or rollback when publication state is not stable and public', async () => {
  for (const response of [
    { draft: false, prerelease: true },
    { draft: true, prerelease: false },
  ]) {
    const fixture = createAggregateFixture();
    try {
      const manifest = aggregateRelease(fixture.options);
      const expected = publishedAssetRecords(manifest);
      const state = { release: undefined, calls: [] };
      const adapter = createFakePublisherAdapter(state, expected);
      adapter.publishDraft = async () => {
        state.calls.push('publish');
        return { ...state.release, ...response };
      };
      await assert.rejects(
        publishRelease({
          adapter,
          commitSha: testCommitSha,
          directory: fixture.output,
          repository: 'owner/repo',
          tag: 'v1.2.3',
          version: '1.2.3',
        }),
        /prerelease=false|manual inspection is required/u,
      );
      assert.equal(state.calls.filter((call) => call === 'publish').length, 1);
      assert.equal(
        state.calls.some((call) => call.startsWith('delete:')),
        false,
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test('release workflow pins actions, scopes signing secrets, binds production, and preserves gate dependencies', () => {
  const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
  for (const use of workflow.matchAll(/uses:\s+([^\s#]+)/gu)) {
    assert.match(use[1], /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/u);
  }
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.doesNotMatch(workflow, /if:\s*always\(\)/u);
  assert.match(workflow, /runs-on: macos-15\n/u);
  assert.match(workflow, /runs-on: macos-15-intel/u);
  assert.equal(workflow.match(/^    environment: Production$/gmu)?.length, 3);
  assert.match(
    workflow,
    /mac_arm64:\n    name: macOS arm64\n    needs: \[classify, quality\]\n    if: .+\n    environment: Production\n    runs-on: macos-15\n/u,
  );
  assert.match(
    workflow,
    /mac_x64:\n    name: macOS x64\n    needs: \[classify, quality\]\n    if: .+\n    environment: Production\n    runs-on: macos-15-intel\n/u,
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
  assert.equal(workflow.match(/contents: write/gu)?.length, 1);
  assert.match(
    workflow,
    /publish:\n    name: Publish release\n    needs: \[classify, aggregate\]\n    environment: Production\n/u,
  );
});

function createAggregateFixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'isagi-release-aggregate-'));
  const linux = resolve(root, 'linux');
  const x64 = resolve(root, 'mac-x64');
  const arm64 = resolve(root, 'mac-arm64');
  const output = resolve(root, 'output');
  for (const directory of [linux, x64, arm64]) mkdirSync(directory, { recursive: true });
  for (const name of [
    'Isagi-linux-x86_64.AppImage',
    'install-isagi-linux.sh',
    'latest-linux.yml',
  ]) {
    writeFileSync(resolve(linux, name), name);
  }
  createMacInput(x64, 'x64');
  createMacInput(arm64, 'arm64');
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

function createMacInput(directory, architecture) {
  const records = [];
  for (const extension of ['zip', 'dmg']) {
    const name = `Isagi-mac-${architecture}.${extension}`;
    const contents = Buffer.from(`${architecture}-${extension}`);
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

function createFakePublisherAdapter(state, expected) {
  return {
    createDraft: async () => {
      state.calls.push('create');
      state.release = { assets: [], draft: true, id: 42, prerelease: false };
      return state.release;
    },
    deleteAsset: async (_repository, assetId) => {
      state.calls.push(`delete:${assetId}`);
      state.release.assets = state.release.assets.filter((asset) => asset.id !== assetId);
    },
    getRelease: async () => state.release,
    publishDraft: async () => {
      state.calls.push('publish');
      state.release = { ...state.release, draft: false, prerelease: false };
      return state.release;
    },
    resolveRemoteTag: async () => {
      state.calls.push('resolve-tag');
      return testCommitSha;
    },
    uploadAsset: async (_tag, path) => {
      const name = path.split('/').at(-1);
      state.calls.push(`upload:${name}`);
      const record = expected.find((asset) => asset.name === name);
      state.release.assets.push({
        digest: `sha256:${record.sha256}`,
        id: state.release.assets.length + 1,
        name,
        size: record.size,
      });
    },
  };
}
