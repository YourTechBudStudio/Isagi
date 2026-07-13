import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  hashArtifact,
  hashWorkflowInputs,
  serializeWorkflowBuildManifest,
  workflowSdkPackage,
  workflowVerifierPackage,
} from '@yourtechbudstudio/isagi-workflow-verifier/receipt';
import { Effect, Either } from 'effect';

import { WorkflowLoadError } from './loader.js';
import { createFilesystemWorkflowRegistry } from './registry.js';

const artifact = `export default {
  command: () => ({ title: 'Packaged workflow' }),
  validate: () => {},
  init: () => ({ version: 1 }),
  step: async () => ({ type: 'done' })
};\n`;

test('loads a verified standalone package and reuses its content-addressed pin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'isagi-workflow-loader-'));
  try {
    const workflows = join(root, 'workflows');
    const cache = join(root, 'cache');
    await writePackage(join(workflows, 'packaged'), artifact);
    const registry = createFilesystemWorkflowRegistry(workflows, cache);
    const latest = await Effect.runPromise(registry.resolveLatest('packaged'));
    assert.ok(latest);
    assert.equal((await latest.definition.command({} as never)).title, 'Packaged workflow');
    await rm(join(workflows, 'packaged', 'node_modules'), { recursive: true, force: true });
    const pinned = await Effect.runPromise(registry.loadPinned(latest.artifactHash, 'packaged'));
    assert.equal((await pinned.definition.command({} as never)).title, 'Packaged workflow');
    assert.equal(await readFile(join(cache, latest.artifactHash, 'index.mjs'), 'utf8'), artifact);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reloads a newly verified artifact while the previous pin remains loadable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'isagi-workflow-reload-'));
  try {
    const workflows = join(root, 'workflows');
    const cache = join(root, 'cache');
    const packageRoot = join(workflows, 'packaged');
    await writePackage(packageRoot, artifact);
    const registry = createFilesystemWorkflowRegistry(workflows, cache);
    const first = await Effect.runPromise(registry.resolveLatest('packaged'));
    assert.ok(first);
    const changed = artifact.replace('Packaged workflow', 'Changed workflow');
    await writePackage(packageRoot, changed);
    const second = await Effect.runPromise(registry.resolveLatest('packaged'));
    assert.ok(second);
    assert.notEqual(first.artifactHash, second.artifactHash);
    assert.equal((await second.definition.command({} as never)).title, 'Changed workflow');
    const pinned = await Effect.runPromise(registry.loadPinned(first.artifactHash, 'packaged'));
    assert.equal((await pinned.definition.command({} as never)).title, 'Packaged workflow');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reports stable reasons for legacy, stale, tampered, and missing pinned artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'isagi-workflow-failures-'));
  try {
    const workflows = join(root, 'workflows');
    const cache = join(root, 'cache');
    const registry = createFilesystemWorkflowRegistry(workflows, cache);
    await mkdir(join(workflows, 'legacy'), { recursive: true });
    await writeFile(join(workflows, 'legacy', 'index.ts'), 'export default {};\n');
    assert.equal(await reason(registry.resolveLatest('legacy')), 'missing_build');

    const staleRoot = join(workflows, 'stale');
    await writePackage(staleRoot, artifact);
    await writeFile(join(staleRoot, 'src', 'index.ts'), '// changed\n');
    assert.equal(await reason(registry.resolveLatest('stale')), 'stale_source');

    const tamperedRoot = join(workflows, 'tampered');
    await writePackage(tamperedRoot, artifact);
    await writeFile(join(tamperedRoot, 'dist', 'index.js'), `${artifact}// tampered\n`);
    assert.equal(await reason(registry.resolveLatest('tampered')), 'artifact_tampered');

    assert.equal(
      await reason(registry.loadPinned('f'.repeat(64), 'missing')),
      'pinned_artifact_unavailable',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preserves project precedence without writing under the project root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'isagi-workflow-precedence-'));
  try {
    const workflows = join(root, 'global');
    const project = join(root, 'project');
    const projectWorkflows = join(project, '.isagi', 'workflows');
    const cache = join(root, 'cache');
    await writePackage(join(workflows, 'shared'), artifact);
    await writePackage(join(projectWorkflows, 'shared'), artifact.replace('Packaged', 'Project'));
    const registry = createFilesystemWorkflowRegistry(workflows, cache);
    const loaded = await Effect.runPromise(
      registry.resolveLatest('shared', { projectId: 1, projectRoot: project }),
    );
    assert.ok(loaded);
    assert.equal((await loaded.definition.command({} as never)).title, 'Project workflow');
    await assert.rejects(readFile(join(projectWorkflows, '.cache')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('distinguishes unsupported manifest, unsupported contract, and invalid package pins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'isagi-workflow-compatibility-'));
  try {
    const workflows = join(root, 'workflows');
    const cache = join(root, 'cache');
    const registry = createFilesystemWorkflowRegistry(workflows, cache);

    for (const [key, field, value, expected] of [
      ['manifest', 'manifestVersion', 2, 'unsupported_manifest'],
      ['contract', 'workflowContractVersion', 2, 'unsupported_contract'],
    ] as const) {
      const packageRoot = join(workflows, key);
      await writePackage(packageRoot, artifact);
      const manifestPath = join(packageRoot, 'dist', 'isagi-workflow-build.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
      manifest[field] = value;
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      assert.equal(await reason(registry.resolveLatest(key)), expected);
    }

    const invalidRoot = join(workflows, 'invalid-package');
    await writePackage(invalidRoot, artifact);
    const packagePath = join(invalidRoot, 'package.json');
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
      dependencies: Record<string, string>;
    };
    packageJson.dependencies[workflowSdkPackage] = '^0.0.1';
    await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    const invalid = await failure(registry.resolveLatest('invalid-package'));
    assert.equal(invalid.reason, 'invalid_package');
    assert.match(invalid.message, /dependencies.*exact semver/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent latest loads publish one valid immutable artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'isagi-workflow-concurrent-'));
  try {
    const workflows = join(root, 'workflows');
    const cache = join(root, 'cache');
    await writePackage(join(workflows, 'packaged'), artifact);
    const registry = createFilesystemWorkflowRegistry(workflows, cache);
    const loaded = await Promise.all(
      Array.from({ length: 8 }, () => Effect.runPromise(registry.resolveLatest('packaged'))),
    );
    assert.ok(loaded.every((entry) => entry?.artifactHash === loaded[0]?.artifactHash));
    const hash = loaded[0]?.artifactHash;
    assert.ok(hash);
    assert.equal(hashArtifact(await readFile(join(cache, hash, 'index.mjs'))), hash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function reason(effect: Effect.Effect<unknown, unknown>) {
  return (await failure(effect)).reason;
}

async function failure(effect: Effect.Effect<unknown, unknown>) {
  const result = await Effect.runPromise(Effect.either(effect));
  assert.equal(Either.isLeft(result), true);
  assert.ok(Either.isLeft(result) && result.left instanceof WorkflowLoadError);
  return result.left;
}

async function writePackage(root: string, artifactText: string) {
  const packageJson = `${JSON.stringify(
    {
      name: 'fixture-workflow',
      private: true,
      dependencies: { [workflowSdkPackage]: '0.0.1' },
      devDependencies: { [workflowVerifierPackage]: '0.0.1' },
    },
    null,
    2,
  )}\n`;
  const inputs = [
    { path: 'src/index.ts', bytes: Buffer.from('// source\n') },
    { path: 'tests/index.test.ts', bytes: Buffer.from('// test\n') },
    { path: 'package.json', bytes: Buffer.from(packageJson) },
    { path: 'tsconfig.json', bytes: Buffer.from('{}\n') },
  ];
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'tests'), { recursive: true });
  await mkdir(join(root, 'dist'), { recursive: true });
  for (const input of inputs) await writeFile(join(root, input.path), input.bytes);
  await writeFile(join(root, 'dist', 'index.js'), artifactText);
  await writeFile(
    join(root, 'dist', 'isagi-workflow-build.json'),
    serializeWorkflowBuildManifest({
      manifestVersion: 1,
      workflowContractVersion: 1,
      sdk: { name: workflowSdkPackage, version: '0.0.1' },
      verifier: { name: workflowVerifierPackage, version: '0.0.1' },
      source: { sha256: hashWorkflowInputs(inputs) },
      artifact: { entry: 'dist/index.js', sha256: hashArtifact(Buffer.from(artifactText)) },
    }),
  );
}
