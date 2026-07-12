import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import test from 'node:test';

import {
  runProcess,
  selectPackageManagerRunner,
  verifyWorkflow,
  type ProcessRunner,
} from './cli.js';
import {
  parseWorkflowBuildManifestJson,
  supportedWorkflowContractVersion,
  workflowBuildManifestVersion,
  workflowSdkPackage,
  workflowSdkVersion,
  workflowVerifierPackage,
  workflowVerifierVersion,
} from './receipt.js';

const repoRoot = resolve(import.meta.dirname, '../../..');

const canonicalFixture = resolve(import.meta.dirname, '../fixtures/minimal-workflow');
const validArtifact = `export default {
  command() { return { title: 'Minimal workflow', inputs: [] }; },
  validate() {},
  init() { return {}; },
  async step() { return { type: 'done' }; }
};
`;

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'isagi-verifier-test-'));
  // The canonical scaffold is the single source of truth. It ships without a lockfile or
  // node_modules (a pre-install scaffold), so the copy adds the test-only lockfile and links the
  // workspace SDK and verifier the way an author's install would.
  await cp(canonicalFixture, root, {
    recursive: true,
    filter: (source) => {
      const top = source.slice(canonicalFixture.length + 1).split(sep)[0];
      return top !== 'node_modules' && top !== 'dist';
    },
  });
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  await linkPackage(
    root,
    '@yourtechbudstudio/isagi-workflow-sdk',
    join(repoRoot, 'packages/workflow-sdk'),
  );
  await linkPackage(
    root,
    '@yourtechbudstudio/isagi-workflow-verifier',
    join(repoRoot, 'packages/workflow-verifier'),
  );
  const builderPath = join(root, 'node_modules/esbuild/package.json');
  await mkdir(dirname(builderPath), { recursive: true });
  await writeFile(builderPath, JSON.stringify({ name: 'esbuild', version: '0.28.0' }));
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist/index.js'), validArtifact);
  return root;
}

async function linkPackage(root: string, name: string, target: string) {
  const path = join(root, 'node_modules', ...name.split('/'));
  await mkdir(dirname(path), { recursive: true });
  await symlink(target, path, 'dir');
}

function testRunner(failScript?: string): ProcessRunner {
  return async (spec) => {
    if (spec.args.includes('--version')) return { stdout: '11.4.0\n', stderr: '' };
    if (spec.args.at(-2) === 'run' || spec.args.includes('run')) {
      const script = spec.args.at(-1);
      if (script === failScript) throw new Error(`${script} failed`);
      return { stdout: '', stderr: '' };
    }
    return runProcess(spec);
  };
}

test('verifies a standalone artifact and deterministic receipt', async () => {
  const root = await fixture();
  await verifyWorkflow(root, testRunner());
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
  const first = await readFile(join(root, 'dist/isagi-workflow-build.json'), 'utf8');
  await verifyWorkflow(root, testRunner());
  assert.equal(await readFile(join(root, 'dist/isagi-workflow-build.json'), 'utf8'), first);
});

test('leaves the existing build and receipt untouched when a trusted script fails', async () => {
  const root = await fixture();
  await writeFile(join(root, 'dist/isagi-workflow-build.json'), 'previous receipt');
  await assert.rejects(verifyWorkflow(root, testRunner('test')), /test failed/);
  assert.equal(await readFile(join(root, 'dist/index.js'), 'utf8'), validArtifact);
  assert.equal(
    await readFile(join(root, 'dist/isagi-workflow-build.json'), 'utf8'),
    'previous receipt',
  );
});

test('fails closed for an existing lock or transaction evidence', async () => {
  const root = await fixture();
  await writeFile(join(root, '.isagi-workflow-verifier-lock'), '');
  await assert.rejects(verifyWorkflow(root, testRunner()), /acquire verification lock/);
  const second = await fixture();
  await mkdir(join(second, '.isagi-workflow-verifier-transaction-abandoned'));
  await assert.rejects(verifyWorkflow(second, testRunner()), /transaction evidence/);
});

test('exclusive lock rejects concurrent verification', async () => {
  const root = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((complete) => {
    release = complete;
  });
  const slow: ProcessRunner = async (spec) => {
    if (spec.args.at(-1) === 'typecheck') await gate;
    return testRunner()(spec);
  };
  const first = verifyWorkflow(root, slow);
  await new Promise((complete) => setTimeout(complete, 50));
  await assert.rejects(verifyWorkflow(root, testRunner()), /acquire verification lock/);
  release();
  await first;
});

test('selects authoritative lifecycle runners for pnpm, npm, and Bun', () => {
  for (const manager of ['pnpm', 'npm', 'bun'] as const) {
    assert.deepEqual(
      selectPackageManagerRunner(manager, {
        npm_config_user_agent: `${manager}/1.2.3 node/v22`,
        npm_execpath: `/tools/${manager}.cjs`,
      }),
      { command: process.execPath, argsPrefix: [`/tools/${manager}.cjs`] },
    );
    assert.deepEqual(selectPackageManagerRunner(manager, {}), { command: manager, argsPrefix: [] });
  }
  assert.deepEqual(
    selectPackageManagerRunner('bun', {
      npm_config_user_agent: 'bun/1.3.5',
      npm_execpath: '/tools/bun',
    }),
    { command: '/tools/bun', argsPrefix: [] },
  );
  assert.throws(
    () =>
      selectPackageManagerRunner('pnpm', {
        npm_config_user_agent: 'npm/11.0.0',
        npm_execpath: '/tools/npm.cjs',
      }),
    /running under npm/,
  );
  assert.throws(
    () => selectPackageManagerRunner('npm', { npm_config_user_agent: 'npm/11.0.0' }),
    /incomplete/,
  );
});

test('requires the workflow-owned build before verification', async () => {
  const root = await fixture();
  await rm(join(root, 'dist/index.js'));
  await assert.rejects(verifyWorkflow(root, testRunner()), /Run the package build command/);
});

test('rejects missing workflow functions, throwing command, and invalid command manifest', async () => {
  for (const source of [
    'export default { command() { return { title: "x" } } };',
    'export default { command() { throw new Error("command exploded") }, validate(){}, init(){}, step(){} };',
    'export default { command() { return { title: "x", inputs: [{ kind: "select", key: "k", label: "K" }] } }, validate(){}, init(){}, step(){} };',
  ]) {
    const root = await fixture();
    await writeFile(join(root, 'dist/index.js'), source);
    await assert.rejects(verifyWorkflow(root, testRunner()), /Workflow|command|exited/i);
  }
});

test('fails when trusted scripts mutate the workflow-owned build output', async () => {
  const root = await fixture();
  const runner: ProcessRunner = async (spec) => {
    if (spec.args.includes('--version')) return { stdout: '11.4.0\n', stderr: '' };
    if (spec.args.at(-1) === 'test') {
      await writeFile(join(root, 'dist/index.js'), `${validArtifact}\n// changed\n`);
      return { stdout: '', stderr: '' };
    }
    if (spec.args.includes('run')) return { stdout: '', stderr: '' };
    return runProcess(spec);
  };
  await assert.rejects(verifyWorkflow(root, runner), /build output changed/);
});

test('fails when trusted scripts mutate a declared input', async () => {
  const root = await fixture();
  const runner: ProcessRunner = async (spec) => {
    if (spec.args.includes('--version')) return { stdout: '11.4.0\n', stderr: '' };
    if (spec.args.at(-1) === 'test') {
      await writeFile(join(root, 'tests/workflow.test.ts'), 'export const changed = true;\n');
      return { stdout: '', stderr: '' };
    }
    if (spec.args.includes('run')) return { stdout: '', stderr: '' };
    return runProcess(spec);
  };
  await assert.rejects(verifyWorkflow(root, runner), /source inputs changed/);
});

test('rejects unsupported lockfiles and source symlinks before verification', async () => {
  const lockRoot = await fixture();
  await writeFile(join(lockRoot, 'bun.lockb'), 'legacy');
  await assert.rejects(verifyWorkflow(lockRoot, testRunner()), /bun.lockb is unsupported/);
  const symlinkRoot = await fixture();
  await symlink(join(symlinkRoot, 'src/index.ts'), join(symlinkRoot, 'src/linked.ts'));
  await assert.rejects(verifyWorkflow(symlinkRoot, testRunner()), /Symlinks are unsupported/);
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
