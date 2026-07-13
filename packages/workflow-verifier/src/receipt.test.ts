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

test('parses and canonically serializes manifest format 1', () => {
  const manifest = {
    manifestVersion: 1,
    workflowContractVersion: 1,
    sdk: { name: '@yourtechbudstudio/isagi-workflow-sdk', version: '0.0.1' },
    verifier: { name: '@yourtechbudstudio/isagi-workflow-verifier', version: '0.0.1' },
    source: { sha256: 'a'.repeat(64) },
    artifact: { entry: 'dist/index.js', sha256: 'b'.repeat(64) },
  };
  const parsed = parseWorkflowBuildManifest(manifest);
  assert.deepEqual(parsed, manifest);
  assert.equal(serializeWorkflowBuildManifest(parsed), `${JSON.stringify(manifest, null, 2)}\n`);
  assert.throws(() => parseWorkflowBuildManifest({ ...manifest, timestamp: 'nope' }), /unexpected/);
});
