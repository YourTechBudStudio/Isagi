import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Effect } from 'effect';

import { parseCanonicalVersion } from './release-version-contract.mjs';
import {
  createPackageVersionPlan,
  syncPackageVersions,
  verifyPackageVersions,
} from './sync-package-versions.mjs';

const execFilePromise = promisify(execFile);
const scriptsDirectory = dirname(fileURLToPath(import.meta.url));

test('accepts canonical app versions without numeric coercion', () => {
  for (const version of ['0.0.0', '1.2.3', '999999999999999999999999.2.3']) {
    const result = parseCanonicalVersion(version);
    assert.equal(result._tag, 'canonical_version');
    assert.equal(result.version, version);
  }
});

test('rejects non-canonical app versions', () => {
  for (const version of ['01.2.3', '1.02.3', '1.2.03', '1.2', '1.2.3-rc.1', '1.2.3+build.4']) {
    assert.equal(parseCanonicalVersion(version)._tag, 'invalid_version', version);
  }
});

test('discovers every private workspace by exclusion and leaves workflow packages unchanged', async (context) => {
  const repoRoot = await createFixtureRepository(context, {
    patterns: ['apps/*', 'packages/*'],
    workspaces: [
      ['apps/runtime', { name: '@isagi/runtime', private: true, version: '1.0.0' }],
      ['apps/future', { name: '@isagi/future', private: true, version: '1.5.0' }],
      ['packages/contracts', { name: '@isagi/contracts', private: true, version: '1.0.0' }],
      workflowSdk('4.0.0'),
      workflowVerifier('5.0.0'),
    ],
  });

  const plan = await Effect.runPromise(
    syncPackageVersions({ repoRoot, requestedVersion: '2.0.0' }),
  );

  assert.deepEqual(plan.synchronizedManifestPaths, [
    'package.json',
    'apps/future/package.json',
    'apps/runtime/package.json',
    'packages/contracts/package.json',
  ]);
  assert.deepEqual(plan.excludedManifestPaths, [
    'packages/workflow-sdk/package.json',
    'packages/workflow-verifier/package.json',
  ]);
  assert.equal((await readPackageJson(repoRoot)).version, '2.0.0');
  assert.equal((await readPackageJson(join(repoRoot, 'apps/future'))).version, '2.0.0');
  assert.equal((await readPackageJson(join(repoRoot, 'apps/runtime'))).version, '2.0.0');
  assert.equal((await readPackageJson(join(repoRoot, 'packages/contracts'))).version, '2.0.0');
  assert.equal((await readPackageJson(join(repoRoot, 'packages/workflow-sdk'))).version, '4.0.0');
  assert.equal(
    (await readPackageJson(join(repoRoot, 'packages/workflow-verifier'))).version,
    '5.0.0',
  );
});

test('normalizes duplicate manifest paths from overlapping workspace patterns', async (context) => {
  const repoRoot = await createFixtureRepository(context, {
    patterns: ['apps/*', 'apps/*', 'packages/*'],
    workspaces: [
      ['apps/runtime', { name: '@isagi/runtime', private: true, version: '1.0.0' }],
      workflowSdk(),
      workflowVerifier(),
    ],
  });

  const plan = await Effect.runPromise(createPackageVersionPlan({ repoRoot }));

  assert.deepEqual(plan.synchronizedManifestPaths, ['package.json', 'apps/runtime/package.json']);
});

test('rejects duplicate package names across distinct manifests', async (context) => {
  const repoRoot = await createFixtureRepository(context, {
    workspaces: [
      ['apps/one', { name: '@isagi/duplicate', private: true, version: '1.0.0' }],
      ['apps/two', { name: '@isagi/duplicate', private: true, version: '1.0.0' }],
      workflowSdk(),
      workflowVerifier(),
    ],
  });

  await assertEffectFailure(
    createPackageVersionPlan({ repoRoot }),
    "Duplicate workspace package name '@isagi/duplicate'",
  );
});

test('requires each independently versioned package exactly once', async (context) => {
  const repoRoot = await createFixtureRepository(context, {
    workspaces: [
      ['apps/runtime', { name: '@isagi/runtime', private: true, version: '1.0.0' }],
      workflowSdk(),
    ],
  });

  await assertEffectFailure(
    createPackageVersionPlan({ repoRoot }),
    "Missing independently versioned workspace package '@yourtechbudstudio/isagi-workflow-verifier'",
  );
});

test('rejects any other public workspace before writing', async (context) => {
  const repoRoot = await createFixtureRepository(context, {
    workspaces: [
      ['apps/runtime', { name: '@isagi/runtime', private: true, version: '1.0.0' }],
      ['packages/public', { name: '@isagi/unexpected-public', version: '1.0.0' }],
      workflowSdk(),
      workflowVerifier(),
    ],
  });
  const writes = [];

  await assertEffectFailure(
    syncPackageVersions({
      repoRoot,
      requestedVersion: '2.0.0',
      fileSystem: instrumentedFileSystem(writes),
    }),
    "Unexpected public workspace package '@isagi/unexpected-public'",
  );

  assert.deepEqual(writes, []);
  assert.equal((await readPackageJson(repoRoot)).version, '1.0.0');
});

test('rejects invalid requested versions before writing', async (context) => {
  const repoRoot = await createFixtureRepository(context);
  const writes = [];

  await assertEffectFailure(
    syncPackageVersions({
      repoRoot,
      requestedVersion: '2.0.0-rc.1',
      fileSystem: instrumentedFileSystem(writes),
    }),
    'Expected canonical MAJOR.MINOR.PATCH',
  );

  assert.deepEqual(writes, []);
});

test('rejects structurally invalid manifests before writing', async (context) => {
  const repoRoot = await createFixtureRepository(context);
  const writes = [];
  await writePackageJson(join(repoRoot, 'apps/runtime'), {
    name: '',
    private: true,
    version: '1.0.0',
  });

  await assertEffectFailure(
    syncPackageVersions({
      repoRoot,
      requestedVersion: '2.0.0',
      fileSystem: instrumentedFileSystem(writes),
    }),
    "Expected apps/runtime/package.json to have a nonempty string 'name'",
  );

  assert.deepEqual(writes, []);
});

test('rejects invalid manifest JSON before writing', async (context) => {
  const repoRoot = await createFixtureRepository(context);
  const writes = [];
  await writeFile(join(repoRoot, 'apps/runtime/package.json'), '{not json}\n');

  await assertEffectFailure(
    syncPackageVersions({
      repoRoot,
      requestedVersion: '2.0.0',
      fileSystem: instrumentedFileSystem(writes),
    }),
    'Could not parse apps/runtime/package.json as JSON',
  );

  assert.deepEqual(writes, []);
});

test('rejects unsupported workspace patterns instead of guessing', async (context) => {
  const repoRoot = await createFixtureRepository(context, {
    patterns: ['apps/**', 'packages/*'],
  });

  await assertEffectFailure(
    createPackageVersionPlan({ repoRoot }),
    "Unsupported pnpm workspace package pattern 'apps/**'",
  );
});

test('verification reports mismatches without writing', async (context) => {
  const repoRoot = await createFixtureRepository(context, {
    workspaces: [
      ['apps/runtime', { name: '@isagi/runtime', private: true, version: '0.9.0' }],
      workflowSdk(),
      workflowVerifier(),
    ],
  });
  const writes = [];

  await assertEffectFailure(
    verifyPackageVersions({ repoRoot, fileSystem: instrumentedFileSystem(writes) }),
    'Package versions are not synchronized to 1.0.0: apps/runtime/package.json',
  );
  assert.deepEqual(writes, []);
});

test('synchronization performs no writes when every target is current', async (context) => {
  const repoRoot = await createFixtureRepository(context);
  const writes = [];

  const plan = await Effect.runPromise(
    syncPackageVersions({ repoRoot, fileSystem: instrumentedFileSystem(writes) }),
  );

  assert.equal(plan.changes.length, 0);
  assert.deepEqual(writes, []);
});

test('discovery spans package patterns separated by blank lines and comments', async (context) => {
  const repoRoot = await createFixtureRepository(context, {
    patterns: ['apps/*', 'packages/*'],
    workspaceFile: [
      'packages:',
      "  - 'packages/*'",
      '',
      '  # applications are released together with the desktop app',
      "  - 'apps/*'",
      'allowBuilds:',
      '  node-pty: true',
      '',
    ].join('\n'),
    workspaces: [
      ['apps/runtime', { name: '@isagi/runtime', private: true, version: '0.9.0' }],
      workflowSdk(),
      workflowVerifier(),
    ],
  });

  const plan = await Effect.runPromise(createPackageVersionPlan({ repoRoot }));

  assert.deepEqual(plan.synchronizedManifestPaths, ['package.json', 'apps/runtime/package.json']);
  assert.deepEqual(
    plan.changes.map(({ relativePath }) => relativePath),
    ['apps/runtime/package.json'],
  );
});

test('discovery rejects unsupported content inside the packages list', async (context) => {
  const repoRoot = await createFixtureRepository(context, {
    workspaceFile: ['packages:', "  - 'apps/*'", '  catalog:', "    effect: '3.0.0'", ''].join(
      '\n',
    ),
  });

  await assertEffectFailure(
    createPackageVersionPlan({ repoRoot }),
    "Unsupported line 'catalog:' inside the 'packages' list of pnpm-workspace.yaml.",
  );
});

test('verification CLI help does not discover the repository', async () => {
  const { stdout, stderr } = await execFilePromise(process.execPath, [
    join(scriptsDirectory, 'verify-package-versions.mjs'),
    '--help',
  ]);

  assert.match(stdout, /^Usage: pnpm versions:verify/m);
  assert.equal(stderr, '');
});

async function createFixtureRepository(
  context,
  { patterns = ['apps/*', 'packages/*'], workspaceFile, workspaces } = {},
) {
  const repoRoot = await mkdtemp(join(tmpdir(), 'isagi-version-sync-'));
  context.after(() => rm(repoRoot, { force: true, recursive: true }));
  await writeFile(
    join(repoRoot, 'pnpm-workspace.yaml'),
    workspaceFile ?? `packages:\n${patterns.map((pattern) => `  - '${pattern}'`).join('\n')}\n`,
  );
  await writePackageJson(repoRoot, { name: 'isagi', private: true, version: '1.0.0' });

  const fixtureWorkspaces = workspaces ?? [
    ['apps/runtime', { name: '@isagi/runtime', private: true, version: '1.0.0' }],
    workflowSdk(),
    workflowVerifier(),
  ];
  for (const [path, packageJson] of fixtureWorkspaces) {
    await writePackageJson(join(repoRoot, path), packageJson);
  }
  for (const pattern of patterns) {
    const directory = pattern.split('/')[0];
    if (directory && !directory.includes('*')) {
      await mkdir(join(repoRoot, directory), { recursive: true });
    }
  }
  return repoRoot;
}

function workflowSdk(version = '4.0.0') {
  return ['packages/workflow-sdk', { name: '@yourtechbudstudio/isagi-workflow-sdk', version }];
}

function workflowVerifier(version = '5.0.0') {
  return [
    'packages/workflow-verifier',
    { name: '@yourtechbudstudio/isagi-workflow-verifier', version },
  ];
}

function instrumentedFileSystem(writes) {
  return {
    readFile,
    readdir,
    writeFile: async (...args) => {
      writes.push(args[0]);
      return writeFile(...args);
    },
  };
}

async function assertEffectFailure(effect, expectedMessage) {
  await assert.rejects(Effect.runPromise(effect), (error) => {
    assert.match(String(error), new RegExp(escapeRegExp(expectedMessage)));
    return true;
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function writePackageJson(directory, packageJson) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
}

async function readPackageJson(directory) {
  return JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
}
