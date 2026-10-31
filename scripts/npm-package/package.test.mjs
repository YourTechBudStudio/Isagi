import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';

import {
  assembleNpmPackage,
  distributionFiles,
  npmPackageManifest,
  packageName,
} from './package.mjs';

const rootManifest = readJson(resolve('package.json'));
const stageDependencies = readJson(resolve('packages/runtime-stage-dependencies/package.json'));

test('the manifest follows the root version and the runtime stage dependencies', () => {
  const manifest = npmPackageManifest({ rootManifest, stageDependencies });
  assert.equal(manifest.name, packageName);
  assert.equal(manifest.version, rootManifest.version);
  assert.deepEqual(manifest.dependencies, stageDependencies.dependencies);
  assert.equal(manifest.engines.node, rootManifest.engines.node);
  assert.equal(manifest.publishConfig.access, 'public');
  assert.equal(manifest.private, undefined);
});

test('the bin is the distribution entry and ships inside files', () => {
  const manifest = npmPackageManifest({ rootManifest, stageDependencies });
  assert.equal(manifest.bin.isagi, `dist/${distributionFiles[0]}`);
  assert.ok(manifest.files.includes(manifest.bin.isagi.split('/')[0]));
});

test('assembly copies the build outputs and packs with an absolute destination', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'isagi-npm-package-'));
  try {
    writeJson(resolve(root, 'package.json'), { version: '1.2.3', engines: { node: '^24' } });
    writeJson(resolve(root, 'packages/runtime-stage-dependencies/package.json'), {
      dependencies: { 'node-pty': '1.0.0' },
    });
    writeText(resolve(root, 'LICENSE'), 'license');
    for (const file of distributionFiles) writeText(resolve(root, 'apps/runtime/dist', file), file);
    writeText(resolve(root, 'apps/runtime/dist/tsconfig.tsbuildinfo'), '{}');
    writeText(resolve(root, 'apps/web/dist/index.html'), '<html></html>');
    writeText(resolve(root, 'apps/web/dist/tsconfig.tsbuildinfo'), '{}');

    // A stub `npm` records its arguments and writes the tarball where `--pack-destination` points.
    const bin = resolve(root, 'bin');
    const record = resolve(root, 'npm-arguments.json');
    writeText(
      resolve(bin, 'npm'),
      `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args, cwd: process.cwd() }));
writeFileSync(resolve(args[args.indexOf('--pack-destination') + 1], 'yourtechbudstudio-isagi-1.2.3.tgz'), '');
`,
    );
    chmodSync(resolve(bin, 'npm'), 0o755);

    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${previousPath}`;
    let result;
    try {
      result = await assembleNpmPackage({ repoRoot: root });
    } finally {
      process.env.PATH = previousPath;
    }

    const outputDirectory = resolve(root, '.generated/npm-package');
    assert.deepEqual(result, {
      packageRoot: resolve(outputDirectory, 'package'),
      tarballPath: resolve(outputDirectory, 'yourtechbudstudio-isagi-1.2.3.tgz'),
    });
    const invocation = readJson(record);
    assert.deepEqual(invocation.args, ['pack', '--pack-destination', outputDirectory]);
    assert.equal(realpathSync(invocation.cwd), realpathSync(result.packageRoot));

    for (const file of distributionFiles) {
      assert.ok(existsSync(resolve(result.packageRoot, 'dist', file)), file);
    }
    assert.equal(existsSync(resolve(result.packageRoot, 'dist/tsconfig.tsbuildinfo')), false);
    assert.ok(existsSync(resolve(result.packageRoot, 'web/index.html')));
    assert.equal(existsSync(resolve(result.packageRoot, 'web/tsconfig.tsbuildinfo')), false);
    assert.ok(existsSync(resolve(result.packageRoot, 'LICENSE')));
    assert.match(readFileSync(resolve(result.packageRoot, 'README.md'), 'utf8'), /isagi serve/u);
    assert.equal(readJson(resolve(result.packageRoot, 'package.json')).version, '1.2.3');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assembly names a missing build output', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'isagi-npm-package-'));
  try {
    await assert.rejects(
      assembleNpmPackage({ repoRoot: root }),
      /Missing build output .*apps\/runtime\/dist\/isagi\.mjs/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeText(path, JSON.stringify(value));
}

function writeText(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}
