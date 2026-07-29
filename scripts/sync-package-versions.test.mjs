import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import { syncPackageVersions } from './sync-package-versions.mjs';

test('synchronizes app and internal package versions without changing workflow package versions', async (context) => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'isagi-version-sync-'));
  context.after(() => rm(repoRoot, { force: true, recursive: true }));

  await writeFile(
    join(repoRoot, 'pnpm-workspace.yaml'),
    "packages:\n  - 'apps/*'\n  - 'packages/*'\n",
  );
  await writePackageJson(repoRoot, { name: 'isagi', private: true, version: '1.0.0' });
  await writePackageJson(join(repoRoot, 'apps/runtime'), {
    name: '@isagi/runtime',
    version: '1.0.0',
  });
  await writePackageJson(join(repoRoot, 'packages/contracts'), {
    name: '@isagi/contracts',
    version: '1.0.0',
  });
  await writePackageJson(join(repoRoot, 'packages/workflow-sdk'), {
    name: '@yourtechbudstudio/isagi-workflow-sdk',
    version: '4.0.0',
  });
  await writePackageJson(join(repoRoot, 'packages/workflow-verifier'), {
    name: '@yourtechbudstudio/isagi-workflow-verifier',
    version: '5.0.0',
  });

  const result = await Effect.runPromise(
    syncPackageVersions({ repoRoot, requestedVersion: '2.0.0' }),
  );

  assert.deepEqual(result, {
    excludedPackageCount: 2,
    synchronizedPackageCount: 2,
    version: '2.0.0',
  });
  assert.equal((await readPackageJson(repoRoot)).version, '2.0.0');
  assert.equal((await readPackageJson(join(repoRoot, 'apps/runtime'))).version, '2.0.0');
  assert.equal((await readPackageJson(join(repoRoot, 'packages/contracts'))).version, '2.0.0');
  assert.equal((await readPackageJson(join(repoRoot, 'packages/workflow-sdk'))).version, '4.0.0');
  assert.equal(
    (await readPackageJson(join(repoRoot, 'packages/workflow-verifier'))).version,
    '5.0.0',
  );
});

async function writePackageJson(directory, packageJson) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
}

async function readPackageJson(directory) {
  return JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
}
