import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { runtimePackageExternals } from '../../runtime/runtime-externals.mjs';
import { serveDistributionFiles } from '../distribution.mjs';

// `apps/cli/package.json` is the published `@yourtechbudstudio/isagi` manifest. These guards keep the facts it repeats
// in step with their owners: the runtime's externals and their versions, the root license and Node range.

type Manifest = {
  readonly name: string;
  readonly private?: boolean;
  readonly bin: Readonly<Record<string, string>>;
  readonly files: readonly string[];
  readonly dependencies: Readonly<Record<string, string>>;
  readonly engines: { readonly node: string };
  readonly publishConfig?: { readonly access?: string };
};

const cliRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(cliRoot, '../..');
const cliManifest = readJson(resolve(cliRoot, 'package.json'));
const runtimeManifest = readJson(resolve(repoRoot, 'apps/runtime/package.json'));
const rootManifest = readJson(resolve(repoRoot, 'package.json'));

test('the shipped dependencies are exactly the runtime externals, at the runtime versions', () => {
  assert.deepEqual(
    Object.keys(cliManifest.dependencies).sort(),
    [...runtimePackageExternals].sort(),
  );
  for (const name of runtimePackageExternals) {
    assert.equal(
      cliManifest.dependencies[name],
      runtimeManifest.dependencies[name],
      `${name} must use the runtime's dependency specifier`,
    );
  }
});

test('the package is public', () => {
  assert.equal(cliManifest.name, '@yourtechbudstudio/isagi');
  assert.equal(cliManifest.private, undefined);
  assert.equal(cliManifest.publishConfig?.access, 'public');
});

test('the LICENSE is a byte-identical copy of the root LICENSE', () => {
  assert.ok(
    readFileSync(resolve(cliRoot, 'LICENSE')).equals(readFileSync(resolve(repoRoot, 'LICENSE'))),
  );
});

test('the Node range follows the root and the README states it', () => {
  assert.deepEqual(cliManifest.engines, rootManifest.engines);
  const readme = readFileSync(resolve(cliRoot, 'README.md'), 'utf8');
  assert.ok(readme.includes(`Requires Node.js ${rootManifest.engines.node}.`));
});

test('the bin is the distribution entry and ships inside files', () => {
  const bin = cliManifest.bin['isagi'] ?? '';
  assert.equal(bin, `dist/${serveDistributionFiles[0]}`);
  assert.ok(cliManifest.files.includes(bin.split('/')[0] ?? ''));
});

function readJson(path: string): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}
