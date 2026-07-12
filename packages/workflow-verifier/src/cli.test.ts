import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';

import { runProcess, verifyWorkflow } from './cli.js';
import {
  parseWorkflowBuildManifestJson,
  supportedWorkflowContractVersion,
  workflowBuildManifestVersion,
  workflowSdkPackage,
  workflowSdkVersion,
  workflowVerifierPackage,
  workflowVerifierVersion,
} from './receipt.js';

const canonicalFixture = resolve(import.meta.dirname, '../fixtures/minimal-workflow');
const validArtifact = `export default {
  command() { return { title: 'Minimal workflow', inputs: [] }; },
  validate() {},
  init() { return {}; },
  async step() { return { type: 'done' }; }
};
`;

// The canonical scaffold is the single source of truth. It ships without a lockfile, node_modules,
// or dist (a pre-install scaffold), so the copy adds the test-only lockfile and a prebuilt artifact
// the way an author's build would.
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'isagi-verifier-test-'));
  await cp(canonicalFixture, root, {
    recursive: true,
    filter: (source) => {
      const top = source.slice(canonicalFixture.length + 1).split(sep)[0];
      return top !== 'node_modules' && top !== 'dist';
    },
  });
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist/index.js'), validArtifact);
  return root;
}

async function editPackageJson(root: string, edit: (pkg: Record<string, any>) => void) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  edit(pkg);
  await writeFile(join(root, 'package.json'), JSON.stringify(pkg, null, 2));
}

test('verifies a workflow and writes a deterministic receipt', async () => {
  const root = await fixture();
  await verifyWorkflow(root);
  const artifact = await readFile(join(root, 'dist/index.js'), 'utf8');
  assert.doesNotMatch(artifact, /@yourtechbudstudio\/isagi-workflow-sdk/);
  const manifest = parseWorkflowBuildManifestJson(
    await readFile(join(root, 'dist/isagi-workflow-build.json'), 'utf8'),
  );
  assert.equal(manifest.artifact.entry, 'dist/index.js');
  // The generated receipt must record the recommended pair and the supported contract/manifest
  // versions, binding the emitted manifest to the receipt constants.
  assert.equal(manifest.manifestVersion, workflowBuildManifestVersion);
  assert.equal(manifest.workflowContractVersion, supportedWorkflowContractVersion);
  assert.equal(manifest.sdk.name, workflowSdkPackage);
  assert.equal(manifest.sdk.version, workflowSdkVersion);
  assert.equal(manifest.verifier.name, workflowVerifierPackage);
  assert.equal(manifest.verifier.version, workflowVerifierVersion);
  assert.equal(manifest.toolchain.packageManager.name, 'pnpm');
  const first = await readFile(join(root, 'dist/isagi-workflow-build.json'), 'utf8');
  await verifyWorkflow(root);
  assert.equal(await readFile(join(root, 'dist/isagi-workflow-build.json'), 'utf8'), first);
});

test('does not require tests/, tsconfig.json, or package scripts', async () => {
  // The verifier gates runtime loadability only. Quality gates (typecheck, tests) and build
  // conventions are the author's responsibility, so their absence must not fail verification.
  const root = await fixture();
  await rm(join(root, 'tests'), { recursive: true });
  await rm(join(root, 'tsconfig.json'));
  await editPackageJson(root, (pkg) => {
    pkg.scripts = {};
  });
  await verifyWorkflow(root);
  parseWorkflowBuildManifestJson(
    await readFile(join(root, 'dist/isagi-workflow-build.json'), 'utf8'),
  );
});

test('requires src/ and a prebuilt dist/index.js with actionable messages', async () => {
  const missingSource = await fixture();
  await rm(join(missingSource, 'src'), { recursive: true });
  await assert.rejects(verifyWorkflow(missingSource), /A src\/ directory is required/);
  const missingBuild = await fixture();
  await rm(join(missingBuild, 'dist/index.js'));
  await assert.rejects(
    verifyWorkflow(missingBuild),
    /dist\/index\.js is missing\. Run the package's build script/,
  );
});

test('states the packageManager rule with the found declaration', async () => {
  const missing = await fixture();
  await editPackageJson(missing, (pkg) => {
    delete pkg.packageManager;
  });
  await assert.rejects(
    verifyWorkflow(missing),
    /"packageManager" as an exact pnpm@, npm@, or bun@/,
  );
  const inexact = await fixture();
  await editPackageJson(inexact, (pkg) => {
    pkg.packageManager = 'pnpm@^11';
  });
  await assert.rejects(verifyWorkflow(inexact), /Found "pnpm@\^11"/);
});

test('states the pin rules with expected and found versions', async () => {
  const root = await fixture();
  await editPackageJson(root, (pkg) => {
    pkg.dependencies[workflowSdkPackage] = '^0.0.1';
  });
  await assert.rejects(
    verifyWorkflow(root),
    new RegExp(`must be exactly "${workflowSdkVersion}"; found "\\^0\\.0\\.1"`),
  );
});

test('requires exactly one lockfile matching the declared manager', async () => {
  const extra = await fixture();
  await writeFile(join(extra, 'package-lock.json'), '{}');
  await assert.rejects(
    verifyWorkflow(extra),
    /Exactly one pnpm-lock\.yaml lockfile is required.*found pnpm-lock\.yaml, package-lock\.json/,
  );
  const legacy = await fixture();
  await writeFile(join(legacy, 'bun.lockb'), 'legacy');
  await assert.rejects(verifyWorkflow(legacy), /bun\.lockb is the legacy binary format/);
});

test('rejects symlinked sources and states the rule', async () => {
  const root = await fixture();
  await symlink(join(root, 'src/index.ts'), join(root, 'src/linked.ts'));
  await assert.rejects(
    verifyWorkflow(root),
    /Symlinks are unsupported in workflow packages: src\/linked\.ts/,
  );
});

test('names package.json in JSON parse failures', async () => {
  const root = await fixture();
  await writeFile(join(root, 'package.json'), '{ not json');
  await assert.rejects(verifyWorkflow(root), /package\.json contains invalid JSON/);
});

test('names the missing workflow definition functions', async () => {
  const root = await fixture();
  await writeFile(
    join(root, 'dist/index.js'),
    'export default { command() { return { title: "x" }; } };',
  );
  await assert.rejects(
    verifyWorkflow(root),
    /missing required function\(s\): validate, init, step/,
  );
});

test('reports a throwing command() with its cause', async () => {
  const root = await fixture();
  await writeFile(
    join(root, 'dist/index.js'),
    'export default { command() { throw new Error("command exploded"); }, validate() {}, init() {}, step() {} };',
  );
  await assert.rejects(verifyWorkflow(root), (error: Error) => {
    assert.match(error.message, /command\(\) threw when called with a minimal launch context/);
    assert.match(error.message, /command exploded/);
    return true;
  });
});

test('pinpoints invalid command() inputs by index and key', async () => {
  const root = await fixture();
  await writeFile(
    join(root, 'dist/index.js'),
    'export default { command() { return { title: "x", inputs: [{ kind: "select", key: "k", label: "K" }] }; }, validate() {}, init() {}, step() {} };',
  );
  await assert.rejects(
    verifyWorkflow(root),
    /inputs\[0\] \(key "k"\) is a select input and needs an options array/,
  );
});

test('tolerates workflow output on stdout during the artifact check', async () => {
  const root = await fixture();
  await writeFile(
    join(root, 'dist/index.js'),
    'console.log("import noise");\nexport default { command() { console.log("command noise"); return { title: "x" }; }, validate() {}, init() {}, step() {} };',
  );
  await verifyWorkflow(root);
});

test('reports a bundle that exits the validation process', async () => {
  const root = await fixture();
  await writeFile(join(root, 'dist/index.js'), 'process.exit(0);\nexport default {};');
  await assert.rejects(verifyWorkflow(root), /terminated the validation process/);
});

test('leaves an existing receipt untouched when verification fails', async () => {
  const root = await fixture();
  await writeFile(join(root, 'dist/isagi-workflow-build.json'), 'previous receipt');
  await writeFile(join(root, 'dist/index.js'), 'export default {};');
  await assert.rejects(verifyWorkflow(root), /failed the artifact check/);
  assert.equal(
    await readFile(join(root, 'dist/isagi-workflow-build.json'), 'utf8'),
    'previous receipt',
  );
});

test('bounds child execution and reports timeout as a controlled failure', async () => {
  await assert.rejects(
    runProcess({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: tmpdir(),
      timeoutMs: 25,
    }),
    /timed out/,
  );
});
