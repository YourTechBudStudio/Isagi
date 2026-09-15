import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hashWorkflowInputs,
  isWorkflowSourcePath,
  parseWorkflowBuildManifest,
  serializeWorkflowBuildManifest,
} from './receipt.js';

test('hashes normalized sorted paths and raw bytes deterministically', () => {
  const first = hashWorkflowInputs([
    { path: 'src/z.ts', bytes: Buffer.from('z\r\n') },
    { path: 'src/a.ts', bytes: Buffer.from('a\n') },
  ]);
  const second = hashWorkflowInputs([
    { path: 'src\\a.ts', bytes: Buffer.from('a\n') },
    { path: './src/z.ts', bytes: Buffer.from('z\r\n') },
  ]);
  assert.equal(first, second);
  assert.notEqual(
    first,
    hashWorkflowInputs([
      { path: 'src/z.ts', bytes: Buffer.from('z\n') },
      { path: 'src/a.ts', bytes: Buffer.from('a\n') },
    ]),
  );
});

test('owns source inclusion and reserved path policy', () => {
  assert.equal(isWorkflowSourcePath('src/data.txt'), true);
  assert.equal(isWorkflowSourcePath('tests/case.ts'), true);
  assert.equal(isWorkflowSourcePath('vite.config.ts'), false);
  assert.equal(isWorkflowSourcePath('pnpm-lock.yaml'), false);
  assert.equal(isWorkflowSourcePath('.isagi-workflow-verifier-lock'), false);
  assert.throws(() => isWorkflowSourcePath('../escape'));
});

test('parses and canonically serializes manifest format 2', () => {
  const manifest = {
    manifestVersion: 2,
    workflowContractVersion: 2,
    sdk: { name: '@yourtechbudstudio/isagi-workflow-sdk', version: '0.1.0' },
    verifier: { name: '@yourtechbudstudio/isagi-workflow-verifier', version: '0.1.0' },
    source: { sha256: 'a'.repeat(64) },
    artifact: { entry: 'dist/index.js', sha256: 'b'.repeat(64) },
    structure: {
      descriptorVersion: 1,
      sha256: 'c'.repeat(64),
      rootGraphKey: 'Minimal',
      graphCount: 1,
    },
  };
  const parsed = parseWorkflowBuildManifest(manifest);
  assert.deepEqual(parsed, manifest);
  assert.equal(serializeWorkflowBuildManifest(parsed), `${JSON.stringify(manifest, null, 2)}\n`);
  assert.throws(() => parseWorkflowBuildManifest({ ...manifest, timestamp: 'nope' }), /unexpected/);
});

test('a receipt without a structure block is not a version 2 receipt', () => {
  // The whole point of the block: a receipt can no longer certify an artifact without saying what
  // structure that artifact declares.
  const { structure, ...withoutStructure } = {
    manifestVersion: 2,
    workflowContractVersion: 2,
    sdk: { name: '@yourtechbudstudio/isagi-workflow-sdk', version: '0.1.0' },
    verifier: { name: '@yourtechbudstudio/isagi-workflow-verifier', version: '0.1.0' },
    source: { sha256: 'a'.repeat(64) },
    artifact: { entry: 'dist/index.js', sha256: 'b'.repeat(64) },
    structure: { descriptorVersion: 1, sha256: 'c'.repeat(64), rootGraphKey: 'M', graphCount: 1 },
  };
  void structure;
  assert.throws(() => parseWorkflowBuildManifest(withoutStructure), /missing fields: structure/);
});

test('the structure block is parsed with exact keys and checked values', () => {
  const base = {
    manifestVersion: 2,
    workflowContractVersion: 2,
    sdk: { name: '@yourtechbudstudio/isagi-workflow-sdk', version: '0.1.0' },
    verifier: { name: '@yourtechbudstudio/isagi-workflow-verifier', version: '0.1.0' },
    source: { sha256: 'a'.repeat(64) },
    artifact: { entry: 'dist/index.js', sha256: 'b'.repeat(64) },
    structure: { descriptorVersion: 1, sha256: 'c'.repeat(64), rootGraphKey: 'M', graphCount: 1 },
  };
  const withStructure = (structure: Record<string, unknown>) =>
    parseWorkflowBuildManifest({ ...base, structure });

  assert.throws(
    () => withStructure({ ...base.structure, extra: 1 }),
    /structure has unexpected fields: extra/,
  );
  assert.throws(
    () => withStructure({ ...base.structure, descriptorVersion: 2 }),
    /Unsupported structure\.descriptorVersion/,
  );
  assert.throws(
    () => withStructure({ ...base.structure, sha256: 'NOT-A-DIGEST' }),
    /structure\.sha256 must be a lowercase SHA-256 digest/,
  );
  assert.throws(
    () => withStructure({ ...base.structure, graphCount: 0 }),
    /structure\.graphCount must be a positive integer/,
  );
  assert.throws(
    () => withStructure({ ...base.structure, rootGraphKey: '' }),
    /structure\.rootGraphKey must be a non-empty string/,
  );
});

test('a contract-version-1 receipt is refused outright', () => {
  assert.throws(
    () =>
      parseWorkflowBuildManifest({
        manifestVersion: 1,
        workflowContractVersion: 1,
        sdk: { name: '@yourtechbudstudio/isagi-workflow-sdk', version: '0.0.1' },
        verifier: { name: '@yourtechbudstudio/isagi-workflow-verifier', version: '0.0.1' },
        source: { sha256: 'a'.repeat(64) },
        artifact: { entry: 'dist/index.js', sha256: 'b'.repeat(64) },
      }),
    /missing fields: structure/,
  );
});
