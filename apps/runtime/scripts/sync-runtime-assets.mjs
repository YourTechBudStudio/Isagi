import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(scriptDir, '..');
const repoRoot = resolve(runtimeRoot, '../..');
const sdkRoot = resolve(repoRoot, 'packages/workflow-sdk');
const sourceAssetRoot = resolve(runtimeRoot, '.generated', 'assets');
const shouldWriteDist = process.argv.includes('--dist');

syncAssets(sourceAssetRoot);

if (shouldWriteDist) {
  syncAssets(resolve(runtimeRoot, 'dist', 'assets'));
}

function syncAssets(assetRoot) {
  rmSync(assetRoot, { recursive: true, force: true });
  mkdirSync(assetRoot, { recursive: true });

  const runtimePackageJson = readJson(resolve(runtimeRoot, 'package.json'));
  const sdkPackageJson = readJson(resolve(sdkRoot, 'package.json'));
  writeText(
    resolve(assetRoot, 'manifest.json'),
    `${JSON.stringify(
      {
        runtimePackageVersion: runtimePackageJson.version ?? '0.0.0',
        workflowSdkPackageVersion: sdkPackageJson.version ?? '0.0.0',
      },
      null,
      2,
    )}\n`,
  );

  copyFile(
    resolve(runtimeRoot, 'src', 'runtime-config', 'runtime-config.schema.ts'),
    resolve(assetRoot, 'config-schemas', 'runtime-config.schema.ts'),
  );
  copyFile(
    resolve(runtimeRoot, 'src', 'project-config', 'project-config.schema.ts'),
    resolve(assetRoot, 'config-schemas', 'project-config.schema.ts'),
  );

  const skillContentRoot = resolve(
    runtimeRoot,
    'src',
    'agent-sessions',
    'harness',
    'skill-content',
  );
  for (const name of ['SKILL.md', 'config-global.md', 'config-project.md', 'workflows.md']) {
    copyFile(resolve(skillContentRoot, name), resolve(assetRoot, 'isagi-docs', name));
  }
}

function copyFile(sourcePath, targetPath) {
  writeText(targetPath, readFileSync(sourcePath, 'utf8'));
}

function writeText(path, source) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source, 'utf8');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
