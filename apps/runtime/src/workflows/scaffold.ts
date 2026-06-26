import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { Data, Effect } from 'effect';

export class WorkflowScaffoldError extends Data.TaggedError('WorkflowScaffoldError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export function ensureWorkflowsScaffold(input: { readonly workflowsPath: string }) {
  return Effect.try({
    try: () => ensureWorkflowsScaffoldSync(input.workflowsPath),
    catch: (cause) =>
      new WorkflowScaffoldError({
        message: `Could not prepare workflows scaffold at ${input.workflowsPath}.`,
        cause,
      }),
  });
}

function ensureWorkflowsScaffoldSync(workflowsPath: string) {
  mkdirSync(workflowsPath, { recursive: true });
  writeIfAbsent(join(workflowsPath, 'package.json'), workflowsPackageJson());
  writeIfAbsent(join(workflowsPath, 'tsconfig.json'), workflowsTsconfigJson());
  syncWorkflowSdkCopy(workflowsPath);
  syncTypePackageCopy(workflowsPath, '@types/node', join('@types', 'node'));
  syncTypePackageCopy(
    workflowsPath,
    'undici-types',
    'undici-types',
    createRequire(join(packageSourceRoot('@types/node'), 'package.json')),
  );
}

function syncWorkflowSdkCopy(workflowsPath: string) {
  const sourceRoot = workflowSdkSourceRoot();
  const sourcePackage = readJson(join(sourceRoot, 'package.json')) as {
    readonly version?: unknown;
  };
  const version = typeof sourcePackage.version === 'string' ? sourcePackage.version : '0.0.0';
  const sourceDist = join(sourceRoot, 'dist');
  if (!existsSync(sourceDist)) {
    throw new Error(`Built workflow SDK dist was not found at ${sourceDist}. Run the SDK build.`);
  }

  const targetRoot = join(workflowsPath, 'node_modules', '@isagi', 'workflow-sdk');
  const targetPackagePath = join(targetRoot, 'package.json');
  const targetVersion = existsSync(targetPackagePath)
    ? (readJson(targetPackagePath) as { readonly version?: unknown }).version
    : null;
  if (targetVersion === version) return;

  rmSync(targetRoot, { recursive: true, force: true });
  mkdirSync(join(targetRoot, 'dist'), { recursive: true });
  cpSync(sourceDist, join(targetRoot, 'dist'), { recursive: true });
  writeFileSync(targetPackagePath, workflowSdkPackageJson(version), 'utf8');
}

function workflowSdkSourceRoot() {
  const require = createRequire(import.meta.url);
  let current = dirname(require.resolve('@isagi/workflow-sdk'));
  while (true) {
    const packagePath = join(current, 'package.json');
    if (existsSync(packagePath)) return current;
    const parent = dirname(current);
    if (parent === current) {
      throw new Error('Could not locate @isagi/workflow-sdk package root.');
    }
    current = parent;
  }
}

function packageSourceRoot(packageName: string, require = createRequire(import.meta.url)) {
  return dirname(require.resolve(`${packageName}/package.json`));
}

function syncTypePackageCopy(
  workflowsPath: string,
  packageName: string,
  targetRelativePath: string,
  require?: NodeRequire,
) {
  const sourceRoot = packageSourceRoot(packageName, require);
  const sourcePackage = readJson(join(sourceRoot, 'package.json')) as {
    readonly version?: unknown;
  };
  const version = typeof sourcePackage.version === 'string' ? sourcePackage.version : '0.0.0';
  const targetRoot = join(workflowsPath, 'node_modules', targetRelativePath);
  const targetPackagePath = join(targetRoot, 'package.json');
  const targetVersion = existsSync(targetPackagePath)
    ? (readJson(targetPackagePath) as { readonly version?: unknown }).version
    : null;
  if (targetVersion === version) return;

  rmSync(targetRoot, { recursive: true, force: true });
  mkdirSync(dirname(targetRoot), { recursive: true });
  cpSync(sourceRoot, targetRoot, { recursive: true });
}

function writeIfAbsent(path: string, contents: string) {
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function workflowsPackageJson() {
  const nodeTypesVersion = packageVersion('@types/node');
  const undiciTypesVersion = packageVersion(
    'undici-types',
    createRequire(join(packageSourceRoot('@types/node'), 'package.json')),
  );
  return `${JSON.stringify(
    {
      private: true,
      type: 'module',
      dependencies: {
        '@isagi/workflow-sdk': '0.0.1',
      },
      devDependencies: {
        '@types/node': nodeTypesVersion,
        'undici-types': undiciTypesVersion,
      },
    },
    null,
    2,
  )}\n`;
}

function packageVersion(packageName: string, require?: NodeRequire) {
  const packageJson = readJson(join(packageSourceRoot(packageName, require), 'package.json')) as {
    readonly version?: unknown;
  };
  return typeof packageJson.version === 'string' ? packageJson.version : '0.0.0';
}

function workflowSdkPackageJson(version: string) {
  return `${JSON.stringify(
    {
      name: '@isagi/workflow-sdk',
      version,
      type: 'module',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: {
        '.': {
          types: './dist/index.d.ts',
          import: './dist/index.js',
        },
      },
    },
    null,
    2,
  )}\n`;
}

function workflowsTsconfigJson() {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        types: ['node'],
      },
    },
    null,
    2,
  )}\n`;
}
