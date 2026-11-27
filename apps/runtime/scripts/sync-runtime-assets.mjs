import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(scriptDir, '..');
const repoRoot = resolve(runtimeRoot, '../..');
const workflowScaffoldRoot = resolve(
  repoRoot,
  'packages/workflow-verifier/fixtures/minimal-workflow',
);
const sourceAssetRoot = resolve(runtimeRoot, '.generated', 'assets');
const shouldWriteDist = process.argv.includes('--dist');

syncAssets(sourceAssetRoot);

if (shouldWriteDist) {
  // The runtime's build output: the `index.js` Vite just built, `assets/` beside it and the
  // migrations `drizzle/` that `migrations.ts` finds beside `index.js`.
  const distRoot = resolve(runtimeRoot, 'dist');
  syncAssets(resolve(distRoot, 'assets'));
  rmSync(resolve(distRoot, 'drizzle'), { recursive: true, force: true });
  cpSync(resolve(runtimeRoot, 'drizzle'), resolve(distRoot, 'drizzle'), { recursive: true });
}

function syncAssets(assetRoot) {
  rmSync(assetRoot, { recursive: true, force: true });
  mkdirSync(assetRoot, { recursive: true });

  const runtimePackageJson = readJson(resolve(runtimeRoot, 'package.json'));
  writeText(
    resolve(assetRoot, 'manifest.json'),
    `${JSON.stringify({ runtimePackageVersion: runtimePackageJson.version ?? '0.0.0' }, null, 2)}\n`,
  );

  copyFile(
    resolve(repoRoot, 'packages/shared/src/global-config/config-schema.ts'),
    resolve(assetRoot, 'config-schemas', 'runtime-config.schema.ts'),
  );
  copyFile(
    resolve(runtimeRoot, 'src', 'projects', 'config', 'config-schema.ts'),
    resolve(assetRoot, 'config-schemas', 'project-config.schema.ts'),
  );

  // The Code Server release pin. Copied verbatim so the shipped runtime reads
  // exactly the bytes the repository reviewed; a drift test asserts the two are
  // identical.
  copyFile(
    resolve(runtimeRoot, 'src', 'editor', 'provisioning', 'code-server.manifest.json'),
    resolve(assetRoot, 'code-server.manifest.json'),
  );

  // Every Markdown file ships except the directory's own agent instructions.
  const skillContentRoot = resolve(runtimeRoot, 'src', 'harnesses', 'skill-content');
  for (const name of readdirSync(skillContentRoot)) {
    if (!name.endsWith('.md') || name === 'AGENTS.md' || name === 'CLAUDE.md') continue;
    copyFile(resolve(skillContentRoot, name), resolve(assetRoot, 'isagi-docs', name));
  }

  // The canonical workflow scaffold is copied verbatim so the shipped skill can carry it as
  // reference files. The verifier fixture is the single source of truth; node_modules and dist
  // are authoring/build output and never part of the scaffold.
  copyWorkflowScaffold(resolve(assetRoot, 'minimal-workflow'));
}

function copyWorkflowScaffold(targetRoot) {
  rmSync(targetRoot, { recursive: true, force: true });
  cpSync(workflowScaffoldRoot, targetRoot, {
    recursive: true,
    filter: (source) => {
      const top = source.slice(workflowScaffoldRoot.length + 1).split(/[\\/]/)[0];
      return top !== 'node_modules' && top !== 'dist';
    },
  });
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
