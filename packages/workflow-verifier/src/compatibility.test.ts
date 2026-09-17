import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  complete,
  createGraph,
  defineWorkflow,
  edge,
  operation,
  outcome,
  reduce,
  workflowContractVersion,
} from '@yourtechbudstudio/isagi-workflow-sdk';

import {
  supportedWorkflowContractVersion,
  workflowBuilderPackage,
  workflowBuilderVersion,
  workflowBuildCommand,
  workflowSdkPackage,
  workflowSdkVersion,
  workflowVerifierPackage,
  workflowVerifierVersion,
  workflowVerifyCommand,
  type WorkflowBuildManifest,
} from './receipt.js';
import { describeWorkflowModule, workflowStructureDescriptorVersion } from './structure.js';

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

test('the canonical scaffold pins the workflow dependencies and commands exactly', () => {
  const pkg = readJson(resolve(fixtureRoot, 'package.json'));
  assert.equal(pkg.dependencies?.[workflowSdkPackage], workflowSdkVersion);
  assert.equal(pkg.devDependencies?.[workflowVerifierPackage], workflowVerifierVersion);
  assert.equal(pkg.devDependencies?.[workflowBuilderPackage], workflowBuilderVersion);
  assert.equal(pkg.scripts?.build, workflowBuildCommand);
  assert.equal(pkg.scripts?.verify, workflowVerifyCommand);
  const verifierPkg = readJson(resolve(verifierRoot, 'package.json'));
  assert.equal(verifierPkg.dependencies?.[workflowBuilderPackage], undefined);
});

test('the SDK and verifier agree on the workflow contract version', () => {
  // Independently declared (the receipt never imports the SDK for the integer); bound here by test.
  assert.equal(workflowContractVersion, supportedWorkflowContractVersion);
});

test('the receipt binds the descriptor version the structure module produces', () => {
  // The receipt declares the literal; the structure module owns it. A bump on one side without the
  // other would let a receipt certify a descriptor shape this release does not produce.
  const manifest: WorkflowBuildManifest = {
    manifestVersion: 2,
    workflowContractVersion: 3,
    sdk: { name: workflowSdkPackage, version: workflowSdkVersion },
    verifier: { name: workflowVerifierPackage, version: workflowVerifierVersion },
    source: { sha256: 'a'.repeat(64) },
    artifact: { entry: 'dist/index.js', sha256: 'b'.repeat(64) },
    structure: {
      descriptorVersion: workflowStructureDescriptorVersion,
      sha256: 'c'.repeat(64),
      rootGraphKey: 'Minimal',
      graphCount: 1,
    },
  };
  assert.equal(manifest.structure.descriptorVersion, workflowStructureDescriptorVersion);
});

test('the structure module recognizes registrations the shipped SDK constructs', () => {
  // Recognition is reimplemented in structure.ts so the packed verifier needs no runtime SDK
  // resolution. This is what binds the two implementations together.
  const graph = createGraph<{ readonly note: string }, {}, { readonly note: string }, string>({
    key: 'Binding',
    title: 'Binding',
    init: (_destination, parameters) => ({ note: parameters.note }),
    state: { note: reduce.replace<string>() },
    entry: 'act',
    nodes: { act: operation(async () => complete()) },
    edges: { fromAct: edge({ from: 'act', to: ['done'], choose: () => ({ to: 'done' }) }) },
    outcomes: { done: outcome({ kind: 'success', output: (state) => state.note }) },
  });
  const result = describeWorkflowModule({
    default: defineWorkflow({ command: () => ({ title: 'B' }), validate: () => {}, graph }),
  });
  assert.ok(result.ok, 'the shipped SDK must be recognized by the shipped structure module');
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
  assert.ok(
    verifierReadme.includes(`${workflowBuilderPackage}@${workflowBuilderVersion}`),
    'verifier README should name the builder pin',
  );
});
