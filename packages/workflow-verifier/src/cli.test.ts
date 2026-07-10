import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import {
  runProcess,
  selectPackageManagerRunner,
  verifyWorkflow,
  type ProcessRunner,
} from './cli.js';
import { parseWorkflowBuildManifestJson } from './receipt.js';

const repoRoot = resolve(import.meta.dirname, '../../..');

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'isagi-verifier-test-'));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'tests'));
  await writeFile(
    join(root, 'src/index.ts'),
    `import { defineWorkflow } from '@yourtechbudstudio/isagi-workflow-sdk';\nexport default defineWorkflow({command:async()=>({title:'Fixture'}),validate:async()=>{},init:async()=>({}),step:async()=>({type:'done'})});\n`,
  );
  await writeFile(join(root, 'tests/workflow.test.ts'), 'export {};\n');
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        target: 'ES2022',
      },
      include: ['src', 'tests'],
    }),
  );
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      private: true,
      type: 'module',
      packageManager: 'pnpm@11.4.0',
      scripts: {
        typecheck: 'tsc --noEmit',
        test: 'node --test',
        build: 'isagi-workflow-verify --workflow .',
        verify: 'isagi-workflow-verify --workflow .',
      },
      dependencies: { '@yourtechbudstudio/isagi-workflow-sdk': '0.0.1' },
      devDependencies: { '@yourtechbudstudio/isagi-workflow-verifier': '0.0.1' },
    }),
  );
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
  const first = await readFile(join(root, 'dist/isagi-workflow-build.json'), 'utf8');
  await verifyWorkflow(root, testRunner());
  assert.equal(await readFile(join(root, 'dist/isagi-workflow-build.json'), 'utf8'), first);
});

test('restores previous dist when a trusted script fails', async () => {
  const root = await fixture();
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist/old.txt'), 'old');
  await assert.rejects(verifyWorkflow(root, testRunner('test')), /test failed/);
  assert.equal(await readFile(join(root, 'dist/old.txt'), 'utf8'), 'old');
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

test('rejects syntax errors and restores the previous verified dist', async () => {
  const root = await fixture();
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist/old.txt'), 'old');
  await writeFile(join(root, 'src/index.ts'), 'export default { nope: ; }\n');
  await assert.rejects(verifyWorkflow(root, testRunner()), /Unexpected|Expected|error/i);
  assert.equal(await readFile(join(root, 'dist/old.txt'), 'utf8'), 'old');
});

test('rejects missing workflow functions, throwing command, and invalid command manifest', async () => {
  for (const source of [
    'export default { command() { return { title: "x" } } };',
    'export default { command() { throw new Error("command exploded") }, validate(){}, init(){}, step(){} };',
    'export default { command() { return { title: "x", inputs: [{ kind: "select", key: "k", label: "K" }] } }, validate(){}, init(){}, step(){} };',
  ]) {
    const root = await fixture();
    await writeFile(join(root, 'src/index.ts'), source);
    await assert.rejects(verifyWorkflow(root, testRunner()), /Workflow|command|exited/i);
  }
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

test('rejects unsupported lockfiles and source symlinks before moving dist', async () => {
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
