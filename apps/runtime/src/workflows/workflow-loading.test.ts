import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import { loadWorkflowDefinition } from './loader.js';
import { ensureWorkflowsScaffold } from './scaffold.js';

const require = createRequire(import.meta.url);

test('scaffolded workflows load through tsx using the copied built SDK', async () => {
  const dataRoot = join(tmpdir(), `isagi-workflow-loading-${process.pid}-${Date.now()}`);
  const workflowsPath = join(dataRoot, 'workflows');
  const workflowPath = join(workflowsPath, 'x');
  try {
    await Effect.runPromise(ensureWorkflowsScaffold({ workflowsPath }));
    mkdirSync(workflowPath, { recursive: true });
    writeWorkflow(
      workflowPath,
      `import { cont, defineWorkflow } from '@isagi/workflow-sdk';

export default defineWorkflow({
  command: () => ({ title: 'Loaded workflow' }),
  validate: () => {},
  init: (_ctx, variables) => ({ phase: String(variables.phase ?? 'initial') }),
  step: async () => cont({ phase: 'first-load' }),
});
`,
    );

    const loaded = await Effect.runPromise(
      loadWorkflowDefinition({
        workflowKey: 'x',
        indexPath: join(workflowPath, 'index.ts'),
      }),
    );
    assert.deepEqual(await loaded.step(emptyCtx(), {}, undefined), {
      type: 'cont',
      state: { phase: 'first-load' },
    });

    writeWorkflow(
      workflowPath,
      `import { defineWorkflow, done } from '@isagi/workflow-sdk';

export default defineWorkflow({
  command: () => ({ title: 'Reloaded workflow' }),
  validate: () => {},
  init: () => ({ phase: 'edited' }),
  step: async () => done({ phase: 'second-load' }),
});
`,
    );

    const reloaded = await Effect.runPromise(
      loadWorkflowDefinition({
        workflowKey: 'x',
        indexPath: join(workflowPath, 'index.ts'),
      }),
    );
    assert.deepEqual(await reloaded.step(emptyCtx(), {}, undefined), {
      type: 'done',
      value: { phase: 'second-load' },
    });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('scaffolded workflows typecheck with Node globals in editors', async () => {
  const dataRoot = join(tmpdir(), `isagi-workflow-types-${process.pid}-${Date.now()}`);
  const workflowsPath = join(dataRoot, 'workflows');
  const workflowPath = join(workflowsPath, 'node-types');
  try {
    await Effect.runPromise(ensureWorkflowsScaffold({ workflowsPath }));
    assert.equal(existsSync(join(workflowsPath, 'node_modules', '@types', 'node')), true);
    assert.equal(existsSync(join(workflowsPath, 'node_modules', 'undici-types')), true);

    mkdirSync(workflowPath, { recursive: true });
    writeWorkflow(
      workflowPath,
      `import { join } from 'node:path';
import { defineWorkflow, done } from '@isagi/workflow-sdk';

export default defineWorkflow({
  command: () => ({ title: join('Node', 'typed workflow') }),
  validate: () => {},
  init: () => ({}),
  step: async () => done(process.cwd()),
});
`,
    );

    execFileSync(
      process.execPath,
      [
        require.resolve('typescript/bin/tsc'),
        '--noEmit',
        '-p',
        'tsconfig.json',
        '--pretty',
        'false',
      ],
      { cwd: workflowsPath, stdio: 'pipe' },
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('workflow scaffold rewrites runtime-owned files and packages on restart', async () => {
  const dataRoot = join(tmpdir(), `isagi-workflow-refresh-${process.pid}-${Date.now()}`);
  const workflowsPath = join(dataRoot, 'workflows');
  try {
    writeFile(workflowsPath, 'package.json', '{"stale":true}\n');
    writeFile(workflowsPath, 'tsconfig.json', '{"compilerOptions":{"types":["stale"]}}\n');
    writeFile(
      workflowsPath,
      join('node_modules', '@isagi', 'workflow-sdk', 'package.json'),
      '{}\n',
    );
    writeFile(workflowsPath, join('node_modules', '@isagi', 'workflow-sdk', 'stale.txt'), 'stale');
    writeFile(workflowsPath, join('node_modules', '@types', 'node', 'package.json'), '{}\n');
    writeFile(workflowsPath, join('node_modules', '@types', 'node', 'stale.txt'), 'stale');
    writeFile(workflowsPath, join('node_modules', 'undici-types', 'package.json'), '{}\n');
    writeFile(workflowsPath, join('node_modules', 'undici-types', 'stale.txt'), 'stale');
    writeFile(workflowsPath, join('node_modules', 'user-installed', 'package.json'), '{}\n');

    await Effect.runPromise(ensureWorkflowsScaffold({ workflowsPath }));

    const packageJson = readJson(join(workflowsPath, 'package.json')) as {
      readonly dependencies?: Record<string, string>;
      readonly devDependencies?: Record<string, string>;
      readonly stale?: boolean;
    };
    const tsconfigJson = readJson(join(workflowsPath, 'tsconfig.json')) as {
      readonly compilerOptions?: { readonly types?: readonly string[] };
    };

    assert.equal(packageJson.stale, undefined);
    assert.equal(packageJson.dependencies?.['@isagi/workflow-sdk'], '0.0.1');
    assert.equal(typeof packageJson.devDependencies?.['@types/node'], 'string');
    assert.deepEqual(tsconfigJson.compilerOptions?.types, ['node']);
    assert.equal(
      existsSync(join(workflowsPath, 'node_modules', '@isagi', 'workflow-sdk', 'stale.txt')),
      false,
    );
    assert.equal(
      existsSync(join(workflowsPath, 'node_modules', '@types', 'node', 'stale.txt')),
      false,
    );
    assert.equal(
      existsSync(join(workflowsPath, 'node_modules', 'undici-types', 'stale.txt')),
      false,
    );
    assert.equal(
      existsSync(join(workflowsPath, 'node_modules', 'user-installed', 'package.json')),
      true,
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

function writeWorkflow(workflowPath: string, contents: string) {
  writeFileSync(join(workflowPath, 'index.ts'), contents, 'utf8');
}

function writeFile(root: string, path: string, contents: string) {
  const target = join(root, path);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function emptyCtx() {
  return {
    worktreePath: '/tmp/isagi-test-worktree',
    spawnSession: async () => {
      throw new Error('spawnSession is not used');
    },
    inject: async () => {},
    closePane: async () => {},
    getConversationHistory: async () => [],
    getHarnessSessionId: async () => {
      throw new Error('getHarnessSessionId is not used');
    },
    runHeadlessPrompt: async () => {
      throw new Error('runHeadlessPrompt is not used');
    },
    startWorkflow: async () => {
      throw new Error('startWorkflow is not used');
    },
    log: async () => {},
    setUiFeedback: async () => {},
  };
}
