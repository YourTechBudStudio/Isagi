/**
 * Opt-in end-to-end proof for the packaged-workflow authoring contract. It is intentionally excluded
 * from `pnpm check`: it packs the public tarballs, installs them into a throwaway copy of the
 * canonical scaffold, verifies it, loads it through the real runtime registry, and finally *runs*
 * it through the real engine until it suspends at its user gate.
 *
 * This is the only place the whole chain is exercised against a genuinely built package:
 *
 *   scaffold → pack/install → typecheck/test/build → verify → registry load → engine launch →
 *   environment preparation → root init → suspend at `user_continue`
 *
 * Run it from the repo root:
 *   pnpm --dir apps/runtime exec tsx scripts/prove-workflow-authoring.mts
 *
 * Two modes, and the difference is reported honestly rather than hidden:
 *
 *   (default)   full proof — every stage above, ending at a suspended run in a real database.
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

import { supportedWorkflowContractVersion } from '@yourtechbudstudio/isagi-workflow-verifier/receipt';

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
    log('verify', 'workflow verified; build manifest written');

    // 5. Delete node_modules — everything below must work from the standalone artifact.
    rmSync(join(workflowDir, 'node_modules'), { recursive: true, force: true });
    log('standalone', 'removed node_modules');

    // 6. Import the standalone artifact directly.
    const artifact = await import(pathToFileURL(join(workflowDir, 'dist/index.js')).href);
    const workflow = artifact.default;
    for (const name of ['command', 'validate'])
      if (typeof workflow?.[name] !== 'function') throw new Error(`artifact missing ${name}()`);
    // Follows the release constant rather than a literal, so a contract bump never leaves this
    // proof asserting the version it replaced.
    if (
      workflow?.isagiContract !== supportedWorkflowContractVersion ||
      workflow?.isagiKind !== 'workflow'
    )
      throw new Error(
        `artifact default export is not a contract-version-${supportedWorkflowContractVersion} workflow definition`,
      );
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
    const { createFilesystemWorkflowRegistry } =
      await import('../src/workflows/structure/registry.js');
    const registry = createFilesystemWorkflowRegistry(workflowsRoot, cacheRoot);
    // Discovery then load, exactly as the runtime does it: the registry no longer offers a
    // resolve-latest shortcut, because a run has to know *which* discovered package it loaded.
    const discovery = await Effect.runPromise(registry.discover());
    const entry = discovery.find(workflowKey);
    if (!entry) throw new Error('runtime registry did not discover the scaffold');
    const loaded = await Effect.runPromise(entry.load());
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
    // Structure is the half the receipt pins, so the proof checks it rather than only the command
    // manifest: every declared graph must be reachable as live code by the key the descriptor uses.
    if (loaded.descriptor.rootGraphKey !== loaded.definition.graph.key)
      throw new Error('descriptor root graph disagrees with the loaded definition');
    for (const graph of loaded.descriptor.graphs) {
      if (!loaded.graphs.has(graph.key))
        throw new Error(`descriptor graph ${graph.key} has no live definition`);
    }
    log(
      'runtime-load',
      `registry loaded ${workflowKey}: title="${manifest.title}", input="${manifest.inputs[0].key}", graphs=${loaded.descriptor.graphs.length}, artifact=${loaded.artifactHash}`,
    );

    // 8. Run it: the production engine against a real database, discovering and loading through the
    //    same registry as step 7. No in-memory definition, no stubbed structure.
    await proveEngineLaunch(registry, loaded.artifactHash);

    process.stdout.write(
      '\nPROOF PASSED — scaffold packed, installed, built, verified, loaded through the runtime' +
        ' registry, and launched through the engine to its user gate.\n',
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/**
 * Launch the verified scaffold through the real engine, and stop where it stops.
 *
 * The scaffold's entry node suspends on `wait.userContinue`, so a correct run reaches that wait and
 * goes no further without a person. That is the assertion: not that the run finished, but that it
 * got to the exact place the author's code says it should. The engine test harness supplies a real,
 * migrated database; only the outside world (worktrees, agents, headless jobs) is faked, and the
 * scaffold is harness-free and takes the default current/current placement, so none of it is used.
 */
async function proveEngineLaunch(
  registry: import('../src/workflows/structure/registry.js').WorkflowRegistryService,
  artifactHash: string,
) {
  const { makeEngineHarness } = await import('../src/workflows/engine/test-support.js');
  const harness = await makeEngineHarness({ registry });
  try {
    const runId = await harness.launch(workflowKey, { inputs: { note: 'proof' } });
    const detail = await harness.run(harness.engine.getRun(runId));
    if (detail.run.status !== 'waiting') {
      throw new Error(`the run is ${detail.run.status}: ${JSON.stringify(detail.run.error)}`);
    }
    if (detail.run.artifactHash !== artifactHash) {
      throw new Error('the run does not use the build the registry verified');
    }
    if (detail.run.current?.wait?.kind !== 'user_continue') {
      throw new Error(
        `the run is not parked on its user gate: ${JSON.stringify(detail.run.current)}`,
      );
    }
    if (harness.places.calls.length > 0 || harness.agents.prompts.length > 0) {
      throw new Error('a default placement launch reached an owning service or an agent');
    }
    log(
      'engine-run',
      `root state ${JSON.stringify(detail.invocations[0]?.state)}; run ${runId} is waiting at` +
        ` ${detail.run.current.nodeId} for the user to continue`,
    );
  } finally {
    await harness.close();
  }
}

main().catch((error) => {
  process.stderr.write(`\nPROOF FAILED: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
