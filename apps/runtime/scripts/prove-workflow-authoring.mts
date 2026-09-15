/**
 * Opt-in end-to-end proof for the packaged-workflow authoring contract. It is intentionally excluded
 * from `pnpm check`: it packs the public tarballs, installs them into a throwaway copy of the
 * canonical scaffold, verifies, and loads the artifact through the real runtime registry path.
 *
 * Run it from the repo root:
 *   pnpm --dir apps/runtime exec tsx scripts/prove-workflow-authoring.mts
 *
 * Two modes, and the difference is reported honestly rather than hidden:
 *
 *   (default)   full proof — every stage, ending at the runtime registry load.
 *   --package-only  the package pipeline only: pack → local install → typecheck → test → build →
 *                   verify → standalone import. It stops before the runtime registry stage and says
 *                   so. It exists so the authoring contract can be proven while the runtime is
 *                   mid-migration; it is never a substitute for the full proof.
 *
 * It never rewrites the fixture. This repository proof uses pnpm as development tooling, while the
 * workflow contract remains package-manager agnostic.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const packageOnly = process.argv.includes('--package-only');

const repoRoot = resolve(import.meta.dirname, '../../..');
const sdkDir = join(repoRoot, 'packages/workflow-sdk');
const verifierDir = join(repoRoot, 'packages/workflow-verifier');
const fixtureDir = join(verifierDir, 'fixtures/minimal-workflow');
const workflowKey = 'my-workflow';

function log(step: string, message: string) {
  process.stdout.write(`\n[${step}] ${message}\n`);
}

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function main() {
  const temp = mkdtempSync(join(tmpdir(), 'isagi-workflow-proof-'));
  const tarballs = join(temp, 'tarballs');
  const workflowsRoot = join(temp, 'workflows');
  const workflowDir = join(workflowsRoot, workflowKey);
  const cacheRoot = join(temp, 'cache');
  mkdirSync(tarballs, { recursive: true });
  mkdirSync(workflowsRoot, { recursive: true });

  try {
    // 1. Pack the public tarballs from freshly built packages.
    run('pnpm', ['build'], sdkDir);
    run('pnpm', ['build'], verifierDir);
    run('pnpm', ['pack', '--pack-destination', tarballs], sdkDir);
    run('pnpm', ['pack', '--pack-destination', tarballs], verifierDir);
    const tarball = (name: string) => {
      const file = readdirSync(tarballs).find((entry) => entry.includes(name));
      if (!file) throw new Error(`No packed tarball for ${name}`);
      return join(tarballs, file);
    };
    const sdkTarball = tarball('isagi-workflow-sdk');
    const verifierTarball = tarball('isagi-workflow-verifier');
    log('pack', `sdk=${sdkTarball}\n        verifier=${verifierTarball}`);

    // 2. Copy the scaffold verbatim, then point the exact dependency names at the local tarballs
    //    through pnpm overrides. The exact semver declarations stay untouched.
    cpSync(fixtureDir, workflowDir, {
      recursive: true,
      filter: (source) => {
        const top = source.slice(fixtureDir.length + 1).split(sep)[0];
        return top !== 'node_modules' && top !== 'dist';
      },
    });
    // pnpm 11 reads overrides from pnpm-workspace.yaml, not package.json. This is the development
    // bridge only: the package's exact dependency/devDependency declarations stay untouched, and this
    // file is not one of the verifier's hashed source inputs.
    writeFileSync(
      join(workflowDir, 'pnpm-workspace.yaml'),
      [
        'packages:',
        '  - .',
        'allowBuilds:',
        '  esbuild: true',
        'overrides:',
        `  '@yourtechbudstudio/isagi-workflow-sdk': file:${sdkTarball}`,
        `  '@yourtechbudstudio/isagi-workflow-verifier': file:${verifierTarball}`,
        '',
      ].join('\n'),
    );

    // 3. Install the proof dependencies. Record store vs network.
    const install = spawnSync('pnpm', ['install', '--prefer-offline'], {
      cwd: workflowDir,
      encoding: 'utf8',
    });
    if (install.status !== 0)
      throw new Error(`pnpm install failed: ${install.stderr || install.stdout}`);
    const provenance = /reused (\d+), downloaded (\d+)/.exec(
      `${install.stdout}\n${install.stderr}`,
    );
    log(
      'install',
      provenance
        ? `third-party deps: reused ${provenance[1]} from the local store, downloaded ${provenance[2]} from the network`
        : 'install complete (pnpm printed no reuse/download summary)',
    );

    // 4. Run the workflow package's own quality gates, then build and verify through its scripts.
    //    These are the author's scripts, run exactly as an author would run them.
    run('pnpm', ['run', 'typecheck'], workflowDir);
    log('typecheck', 'workflow-owned typecheck passed against the installed SDK');
    run('pnpm', ['run', 'test'], workflowDir);
    log('test', 'workflow-owned tests passed');
    run('pnpm', ['run', 'build'], workflowDir);
    log('build', 'workflow-owned build produced dist/index.js');
    run('pnpm', ['run', 'verify'], workflowDir);
    log('verify', 'workflow verified; build receipt written');

    // 5. Delete node_modules — everything below must work from the standalone artifact.
    rmSync(join(workflowDir, 'node_modules'), { recursive: true, force: true });
    log('standalone', 'removed node_modules');

    // 6. Import the standalone artifact directly.
    const artifact = await import(pathToFileURL(join(workflowDir, 'dist/index.js')).href);
    const workflow = artifact.default;
    for (const name of ['command', 'validate'])
      if (typeof workflow?.[name] !== 'function') throw new Error(`artifact missing ${name}()`);
    if (workflow?.isagiContract !== 2 || workflow?.isagiKind !== 'workflow')
      throw new Error('artifact default export is not a contract-version-2 workflow definition');
    if (workflow?.graph?.isagiKind !== 'graph')
      throw new Error('artifact default export carries no root graph');
    const directManifest = await workflow.command({
      worktreeId: 0,
      worktreePath: workflowDir,
      surfaceId: 0,
      paneId: null,
      agentSessionId: null,
    });
    if (directManifest.title !== 'Minimal workflow')
      throw new Error(`unexpected artifact title: ${directManifest.title}`);
    log('import', `standalone artifact command title = ${directManifest.title}`);

    if (packageOnly) {
      process.stdout.write(
        '\nPACKAGE PROOF PASSED — the runtime registry stage was NOT run.\n' +
          'This is not full integration evidence. Run without --package-only for that.\n',
      );
      return;
    }

    // 7. Load through the real runtime verified-package path (validate → publish → import).
    //    Imported here, not at module scope, so --package-only does not depend on runtime code.
    const { Effect } = await import('effect');
    const { createFilesystemWorkflowRegistry } = await import('../src/workflows/registry.js');
    const registry = createFilesystemWorkflowRegistry(workflowsRoot, cacheRoot);
    const loaded = await Effect.runPromise(registry.resolveLatest(workflowKey));
    if (!loaded) throw new Error('runtime registry returned no definition');
    const manifest = await loaded.definition.command({
      worktreeId: 0,
      worktreePath: workflowDir,
      surfaceId: 0,
      paneId: null,
      agentSessionId: null,
    });
    if (manifest.title !== 'Minimal workflow')
      throw new Error(`runtime load returned unexpected title: ${manifest.title}`);
    if (manifest.inputs?.[0]?.key !== 'note')
      throw new Error('runtime load lost the declared input shape');
    if (!readdirSync(join(cacheRoot, loaded.artifactHash)).includes('index.mjs'))
      throw new Error('verified artifact was not published to the content-addressed cache');
    log(
      'runtime-load',
      `registry loaded ${workflowKey}: title="${manifest.title}", input="${manifest.inputs[0].key}", artifact=${loaded.artifactHash}`,
    );

    process.stdout.write('\nPROOF PASSED\n');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`\nPROOF FAILED: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
