import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { Effect, Either } from 'effect';

import { loadWorkflowDefinition, WorkflowLoadError } from './loader.js';
import { createFilesystemWorkflowRegistry } from './registry.js';
import { ensureWorkflowsScaffold } from './scaffold.js';

const require = createRequire(import.meta.url);

test('scaffolded workflows load through compiled artifacts using the copied built SDK', async () => {
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
        artifactPath: workflowArtifactPath(workflowsPath, 'x', 'first-load'),
        compileMode: 'external',
      }),
    );
    assert.equal(existsSync(workflowArtifactPath(workflowsPath, 'x', 'first-load')), true);
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
        artifactPath: workflowArtifactPath(workflowsPath, 'x', 'second-load'),
        compileMode: 'external',
      }),
    );
    assert.equal(existsSync(workflowArtifactPath(workflowsPath, 'x', 'second-load')), true);
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

test('workflow loader tags TypeScript syntax failures as compile diagnostics', async () => {
  const dataRoot = join(tmpdir(), `isagi-workflow-compile-fail-${process.pid}-${Date.now()}`);
  const workflowsPath = join(dataRoot, 'workflows');
  const workflowPath = join(workflowsPath, 'syntax-error');
  try {
    await Effect.runPromise(ensureWorkflowsScaffold({ workflowsPath }));
    writeWorkflow(
      workflowPath,
      `import { defineWorkflow } from '@isagi/workflow-sdk';

export default defineWorkflow({
  command: () => ({ title: 'Syntax error' }),
  validate: () => {},
  init: () => ({}),
  step: async () => {
});
`,
    );

    const result = await Effect.runPromise(
      loadWorkflowDefinition({
        workflowKey: 'syntax-error',
        indexPath: join(workflowPath, 'index.ts'),
        artifactPath: workflowArtifactPath(workflowsPath, 'syntax-error', 'syntax-error'),
        compileMode: 'external',
      }).pipe(Effect.either),
    );

    assert.equal(Either.isLeft(result), true);
    assert.equal(Either.isLeft(result) && result.left instanceof WorkflowLoadError, true);
    assert.equal(Either.isLeft(result) ? result.left.stage : undefined, 'compile');
    assert.match(Either.isLeft(result) ? result.left.message : '', /Expected/);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('workflow loader tags missing definition fields as shape diagnostics', async () => {
  const dataRoot = join(tmpdir(), `isagi-workflow-shape-fail-${process.pid}-${Date.now()}`);
  const workflowsPath = join(dataRoot, 'workflows');
  const workflowPath = join(workflowsPath, 'missing-step');
  try {
    await Effect.runPromise(ensureWorkflowsScaffold({ workflowsPath }));
    writeWorkflow(
      workflowPath,
      `export default {
  command: () => ({ title: 'Missing step' }),
  validate: () => {},
  init: () => ({}),
};
`,
    );

    const result = await Effect.runPromise(
      loadWorkflowDefinition({
        workflowKey: 'missing-step',
        indexPath: join(workflowPath, 'index.ts'),
        artifactPath: workflowArtifactPath(workflowsPath, 'missing-step', 'missing-step'),
        compileMode: 'external',
      }).pipe(Effect.either),
    );

    assert.equal(Either.isLeft(result), true);
    assert.equal(Either.isLeft(result) && result.left instanceof WorkflowLoadError, true);
    assert.equal(Either.isLeft(result) ? result.left.stage : undefined, 'shape');
    assert.match(Either.isLeft(result) ? result.left.message : '', /step/);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('filesystem workflow registry caches definitions until source files change', async () => {
  const dataRoot = join(tmpdir(), `isagi-workflow-registry-cache-${process.pid}-${Date.now()}`);
  const workflowsPath = join(dataRoot, 'workflows');
  const workflowPath = join(workflowsPath, 'cached');
  try {
    await Effect.runPromise(ensureWorkflowsScaffold({ workflowsPath }));
    mkdirSync(workflowPath, { recursive: true });
    writeWorkflowHelper(workflowPath, `export const value = 1;\n`);
    writeWorkflow(
      workflowPath,
      `import { defineWorkflow, done } from '@isagi/workflow-sdk';
import { value } from './helper.js';

export default defineWorkflow({
  command: () => ({ title: 'Cached workflow' }),
  validate: () => {},
  init: () => ({}),
  step: async () => done(value),
});
`,
    );

    const registry = createFilesystemWorkflowRegistry(workflowsPath);
    const first = await Effect.runPromise(registry.get('cached'));
    const second = await Effect.runPromise(registry.get('cached'));
    assert.ok(first);
    assert.equal(second, first);
    assert.deepEqual(await second.step(emptyCtx(), {}, undefined), {
      type: 'done',
      value: 1,
    });

    writeWorkflowHelper(workflowPath, `export const value = 2;\n`);

    const reloaded = await Effect.runPromise(registry.get('cached'));
    assert.ok(reloaded);
    assert.notEqual(reloaded, first);
    assert.deepEqual(await reloaded.step(emptyCtx(), {}, undefined), {
      type: 'done',
      value: 2,
    });
    assert.equal(existsSync(join(workflowsPath, '.cache', 'workflow-definitions')), true);
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

test('workflow scaffold provisions the SDK from embedded build assets', async () => {
  const dataRoot = join(tmpdir(), `isagi-workflow-sdk-assets-${process.pid}-${Date.now()}`);
  const workflowsPath = join(dataRoot, 'workflows');
  try {
    await Effect.runPromise(ensureWorkflowsScaffold({ workflowsPath }));

    const sdkRoot = join(workflowsPath, 'node_modules', '@isagi', 'workflow-sdk');
    const packageJson = readJson(join(sdkRoot, 'package.json')) as {
      readonly exports?: { readonly '.'?: { readonly import?: string; readonly types?: string } };
    };
    assert.equal(packageJson.exports?.['.']?.import, './dist/index.js');
    assert.equal(packageJson.exports?.['.']?.types, './dist/index.d.ts');
    assert.match(readFileSync(join(sdkRoot, 'dist', 'index.js'), 'utf8'), /defineWorkflow/);
    assert.match(readFileSync(join(sdkRoot, 'dist', 'index.d.ts'), 'utf8'), /WorkflowDefinition/);

    const loaded = (await import(pathToFileURL(join(sdkRoot, 'dist', 'index.js')).href)) as {
      readonly defineWorkflow?: unknown;
    };
    assert.equal(typeof loaded.defineWorkflow, 'function');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('filesystem workflow registry merges global and project workflows with project precedence', async () => {
  const dataRoot = join(tmpdir(), `isagi-workflow-roots-${process.pid}-${Date.now()}`);
  const projectRoot = join(tmpdir(), `isagi-project-workflows-${process.pid}-${Date.now()}`);
  const workflowsPath = join(dataRoot, 'workflows');
  const projectWorkflowsPath = join(projectRoot, '.isagi', 'workflows');
  try {
    await Effect.runPromise(ensureWorkflowsScaffold({ workflowsPath }));
    writeWorkflow(
      join(workflowsPath, 'global-only'),
      `import { defineWorkflow, done } from '@isagi/workflow-sdk';

export default defineWorkflow({
  command: () => ({ title: 'Global only' }),
  validate: () => {},
  init: () => ({}),
  step: async () => done('global-only'),
});
`,
    );
    writeWorkflow(
      join(workflowsPath, 'shared'),
      `import { defineWorkflow, done } from '@isagi/workflow-sdk';

export default defineWorkflow({
  command: () => ({ title: 'Global shared' }),
  validate: () => {},
  init: () => ({}),
  step: async () => done('global-shared'),
});
`,
    );
    writeWorkflow(
      join(projectWorkflowsPath, 'project-only'),
      `import { defineWorkflow, done } from '@isagi/workflow-sdk';

export default defineWorkflow({
  command: () => ({ title: 'Project only' }),
  validate: () => {},
  init: () => ({}),
  step: async () => done('project-only'),
});
`,
    );
    writeWorkflow(
      join(projectWorkflowsPath, 'shared'),
      `import { defineWorkflow, done } from '@isagi/workflow-sdk';

export default defineWorkflow({
  command: () => ({ title: 'Project shared' }),
  validate: () => {},
  init: () => ({}),
  step: async () => done('project-shared'),
});
`,
    );

    const registry = createFilesystemWorkflowRegistry(workflowsPath);
    const context = { projectId: 7, projectRoot };
    assert.deepEqual(await Effect.runPromise(registry.knownKeys(context)), [
      'global-only',
      'project-only',
      'shared',
    ]);

    const globalOnly = await Effect.runPromise(registry.get('global-only', context));
    const projectOnly = await Effect.runPromise(registry.get('project-only', context));
    const shared = await Effect.runPromise(registry.get('shared', context));
    assert.equal((await globalOnly?.command(emptyLaunchCtx()))?.title, 'Global only');
    assert.equal((await projectOnly?.command(emptyLaunchCtx()))?.title, 'Project only');
    assert.equal((await shared?.command(emptyLaunchCtx()))?.title, 'Project shared');
    assert.deepEqual(await shared?.step(emptyCtx(), {}, undefined), {
      type: 'done',
      value: 'project-shared',
    });

    assert.equal(existsSync(join(projectWorkflowsPath, '.cache')), false);
    assert.equal(
      existsSync(join(workflowsPath, '.cache', 'workflow-definitions', 'projects', '7', 'shared')),
      true,
    );
    assert.equal(existsSync(join(projectRoot, 'node_modules')), false);
    assert.equal(existsSync(join(projectRoot, '.isagi', 'node_modules')), false);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

function writeWorkflow(workflowPath: string, contents: string) {
  mkdirSync(workflowPath, { recursive: true });
  writeFileSync(join(workflowPath, 'index.ts'), contents, 'utf8');
}

function writeWorkflowHelper(workflowPath: string, contents: string) {
  writeFileSync(join(workflowPath, 'helper.ts'), contents, 'utf8');
}

function writeFile(root: string, path: string, contents: string) {
  const target = join(root, path);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function workflowArtifactPath(workflowsPath: string, workflowKey: string, sourceHash: string) {
  return join(
    workflowsPath,
    '.cache',
    'workflow-definitions',
    workflowKey,
    sourceHash,
    'index.mjs',
  );
}

function emptyCtx() {
  return {
    worktreePath: '/tmp/isagi-test-worktree',
    spawnAgentSession: async () => {
      throw new Error('spawnAgentSession is not used');
    },
    sendAgentPrompt: async () => {
      throw new Error('sendAgentPrompt is not used');
    },
    closePane: async () => {},
    getConversationHistory: async () => [],
    getHarnessSessionId: async () => {
      throw new Error('getHarnessSessionId is not used');
    },
    runHeadlessAgent: async () => {
      throw new Error('runHeadlessAgent is not used');
    },
    startWorkflow: async () => {
      throw new Error('startWorkflow is not used');
    },
    log: async () => {},
    setUiFeedback: async () => {},
  };
}

function emptyLaunchCtx() {
  return {
    worktreeId: 1,
    worktreePath: '/tmp/isagi-test-worktree',
    surfaceId: 1,
    paneId: null,
    agentSessionId: null,
  };
}
