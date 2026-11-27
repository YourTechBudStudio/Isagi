import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';

import { serveDistributionFiles } from '../distribution.mjs';
import { assembleDistribution, checkDistribution } from './assemble-distribution.mjs';

test('assembly puts the runtime build beside isagi.mjs and the web build in web/, without build caches', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'isagi-cli-assembly-'));
  try {
    const cliRoot = resolve(root, 'cli');
    writeText(resolve(cliRoot, 'dist/isagi.mjs'), '#!/usr/bin/env node\n');
    for (const file of serveDistributionFiles.slice(1)) {
      writeText(resolve(root, 'runtime/dist', file), file);
    }
    writeText(resolve(root, 'runtime/dist/tsconfig.tsbuildinfo'), '{}');
    writeText(resolve(root, 'web/dist/index.html'), '<html></html>');
    writeText(resolve(root, 'web/dist/tsconfig.tsbuildinfo'), '{}');
    writeText(resolve(cliRoot, 'web/stale.js'), 'stale');

    assembleDistribution({ root: cliRoot });

    for (const file of serveDistributionFiles) {
      assert.ok(existsSync(resolve(cliRoot, 'dist', file)), file);
    }
    assert.equal(statSync(resolve(cliRoot, 'dist/isagi.mjs')).mode & 0o111, 0o111);
    assert.equal(existsSync(resolve(cliRoot, 'dist/tsconfig.tsbuildinfo')), false);
    assert.ok(existsSync(resolve(cliRoot, 'web/index.html')));
    assert.equal(existsSync(resolve(cliRoot, 'web/tsconfig.tsbuildinfo')), false);
    assert.equal(existsSync(resolve(cliRoot, 'web/stale.js')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assembly names every missing build output and copies nothing', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'isagi-cli-assembly-'));
  try {
    const cliRoot = resolve(root, 'cli');
    writeText(resolve(cliRoot, 'dist/isagi.mjs'), '');
    writeText(resolve(root, 'web/dist/index.html'), '<html></html>');
    assert.throws(
      () => assembleDistribution({ root: cliRoot }),
      /Missing build output .*runtime\/dist\/index\.js, .*runtime\/dist\/assets\/manifest\.json, .*runtime\/dist\/drizzle\/meta\/_journal\.json; run pnpm build first\./u,
    );
    assert.equal(existsSync(resolve(cliRoot, 'web')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the pack check accepts an assembled distribution and refuses a bare bundle or a build cache', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'isagi-cli-assembly-'));
  try {
    writeText(resolve(root, 'dist/isagi.mjs'), '');
    assert.throws(
      () => checkDistribution({ root }),
      /Incomplete distribution: missing .*dist\/index\.js, .*dist\/assets\/manifest\.json, .*dist\/drizzle\/meta\/_journal\.json, .*web\/index\.html; run pnpm -w build/u,
    );
    for (const file of serveDistributionFiles) writeText(resolve(root, 'dist', file), file);
    writeText(resolve(root, 'web/index.html'), '<html></html>');
    checkDistribution({ root });
    writeText(resolve(root, 'dist/tsconfig.tsbuildinfo'), '{}');
    assert.throws(
      () => checkDistribution({ root }),
      /holds build caches dist\/tsconfig\.tsbuildinfo; run pnpm -w build/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeText(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}
