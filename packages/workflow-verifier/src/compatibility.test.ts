import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { workflowContractVersion } from '@yourtechbudstudio/isagi-workflow-sdk';

import {
  supportedWorkflowContractVersion,
  workflowSdkPackage,
  workflowSdkVersion,
  workflowVerifierPackage,
  workflowVerifierVersion,
} from './receipt.js';

// The receipt constants are the single source of truth for the recommended pair. Nothing enforces
// that they match the packages that ship, the scaffold authors copy, or the READMEs — so these
// tests bind them. Without this, the constants could drift while every downstream consumer stayed
// consistently wrong.
const repoRoot = resolve(import.meta.dirname, '../../..');
const sdkRoot = resolve(repoRoot, 'packages/workflow-sdk');
const verifierRoot = resolve(repoRoot, 'packages/workflow-verifier');
const fixtureRoot = resolve(verifierRoot, 'fixtures/minimal-workflow');

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('the receipt pair matches the published SDK and verifier package manifests', () => {
  const sdkPkg = readJson(resolve(sdkRoot, 'package.json'));
  assert.equal(sdkPkg.name, workflowSdkPackage);
  assert.equal(sdkPkg.version, workflowSdkVersion);
  const verifierPkg = readJson(resolve(verifierRoot, 'package.json'));
  assert.equal(verifierPkg.name, workflowVerifierPackage);
  assert.equal(verifierPkg.version, workflowVerifierVersion);
  assert.equal(verifierPkg.peerDependencies?.[workflowSdkPackage], workflowSdkVersion);
});

test('the canonical scaffold pins the receipt pair exactly', () => {
  const pkg = readJson(resolve(fixtureRoot, 'package.json'));
  assert.equal(pkg.dependencies?.[workflowSdkPackage], workflowSdkVersion);
  assert.equal(pkg.devDependencies?.[workflowVerifierPackage], workflowVerifierVersion);
});

test('the SDK and verifier agree on the workflow contract version', () => {
  // Independently declared (the receipt never imports the SDK for the integer); bound here by test.
  assert.equal(workflowContractVersion, supportedWorkflowContractVersion);
});

test('the READMEs name the versions each package owns', () => {
  // The SDK owns and states only its own version; the verifier owns the exact pairing through its
  // peer dependency, so its README names the full pair.
  const sdkReadme = readFileSync(resolve(sdkRoot, 'README.md'), 'utf8');
  assert.ok(
    sdkReadme.includes(`\`${workflowSdkVersion}\``),
    'SDK README should state its own version',
  );

  const verifierReadme = readFileSync(resolve(verifierRoot, 'README.md'), 'utf8');
  assert.ok(
    verifierReadme.includes(`${workflowSdkPackage}@${workflowSdkVersion}`),
    'verifier README should name the SDK pin',
  );
  assert.ok(
    verifierReadme.includes(`${workflowVerifierPackage}@${workflowVerifierVersion}`),
    'verifier README should name the verifier pin',
  );
});
