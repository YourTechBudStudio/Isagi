/**
 * Opt-in end-to-end proof for the packaged-workflow authoring contract. It is intentionally excluded
 * from `pnpm check`: it packs the public tarballs, installs them into a throwaway copy of the
 * canonical scaffold, verifies it, loads it through the real runtime registry, and finally *runs*
 * it through the real interpreter until it suspends at its user gate.
 *
 * This is the only place the whole chain is exercised against a genuinely built package:
 *
 *   scaffold → pack/install → typecheck/test/build → verify → registry load → engine launch →
 *   environment preparation (forked, as production forks it) → root init → suspend at
 *   `user_continue`
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

import type { PreparationDeps } from '../src/workflows/engine/environment/types.js';
// Type-only, so nothing here loads runtime source at module scope — the stages below import their
// implementations dynamically, after the packages have been built. These two annotate the dependency
// objects further down: without them the objects are structurally unchecked, and a required field
// added to either interface would leave this proof compiling and then dying on a path the default
// placement never takes.
import type { LaunchDeps } from '../src/workflows/engine/launch.js';

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
    const loaded = await Effect.runPromise(registry.loadDiscovered(entry));
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

    // 8. Run it. Everything below is the production interpreter against a real database, a real
    //    artifact catalog sharing the registry's cache root, and the verified artifact from step 7 —
    //    no in-memory definition, no stubbed structure.
    await proveEngineLaunch({ workflowsRoot, cacheRoot, artifactHash: loaded.artifactHash });

    process.stdout.write(
      '\nPROOF PASSED — scaffold packed, installed, built, verified, loaded through the runtime' +
        ' registry, and launched through the interpreter to its user gate.\n',
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/**
 * Launch the verified scaffold through the real interpreter, and stop where it stops.
 *
 * The scaffold's entry node suspends on `wait.userContinue`, so a correct run reaches an armed
 * `user_continue` wait and goes no further without a person. That is the assertion: not that the run
 * finished, but that it got to the exact place the author's code says it should and is sitting on a
 * durable wait nobody has answered.
 *
 * Capability adapters are deliberately refusing stubs. The canonical scaffold is harness-free, so a
 * proof that needed a provider would be proving something about the provider instead — and if the
 * scaffold ever starts calling a capability, this fails loudly rather than quietly faking one.
 *
 * Owning services are refusing stubs for the same reason, and here that is an assertion rather than
 * a convenience. The scaffold declares no `environment` hook and this proof passes no `placement`,
 * so the run takes the default `current`/`current` placement — which allocates nothing. Every
 * allocating owning-service operation therefore dies if it is reached, and `owning.calls` is
 * asserted empty below: a default launch that reached an owning service at all — never mind created
 * a worktree — would fail this proof instead of quietly succeeding against a fake.
 */
async function proveEngineLaunch(input: {
  readonly workflowsRoot: string;
  readonly cacheRoot: string;
  readonly artifactHash: string;
}) {
  const { Effect, Exit, Fiber, Scope } = await import('effect');
  const { makeWorkflowPersistenceFixture } =
    await import('../src/workflows/persistence/test-support.js');
  const { owningServices, placementReaders } =
    await import('../src/workflows/engine/test-support.js');
  const { prepareEnvironment } = await import('../src/workflows/engine/environment/preparation.js');
  const { makeWorkflowArtifactCatalog } =
    await import('../src/workflows/structure/artifact-catalog.js');
  const { createFilesystemWorkflowRegistry } =
    await import('../src/workflows/structure/registry.js');
  const { makeWorkflowOperationService } =
    await import('../src/workflows/operations/operation.service.js');
  const { makeWaitResolver } = await import('../src/workflows/waits/resolver.js');
  const { makeDispatcher } = await import('../src/workflows/engine/dispatcher.js');
  const { startWorkflow } = await import('../src/workflows/engine/launch.js');

  const fixture = makeWorkflowPersistenceFixture();
  const scope = await Effect.runPromise(Scope.make());
  try {
    const placement = fixture.seedPlacement();
    const readers = placementReaders(fixture, placement);
    const owning = owningServices(fixture);
    // The catalog and the registry share one cache root, exactly as the runtime layer wires them:
    // a pin published at launch has to be the pin the next dispatch loads.
    const definitionCache = new Map();
    const catalog = makeWorkflowArtifactCatalog(fixture.database, fixture.payloads, {
      cacheRoot: input.cacheRoot,
      definitionCache,
    });
    const registry = createFilesystemWorkflowRegistry(input.workflowsRoot, input.cacheRoot);

    const refuse = (name: string) => () =>
      Effect.die(
        new Error(
          `the canonical scaffold called ${name}; this proof deliberately provides no harness`,
        ),
      );
    const adapters = {
      agentSessions: {
        prepareSend: refuse('prepareSend'),
        createKeyedSession: refuse('createKeyedSession'),
        prepareSeed: refuse('prepareSeed'),
        submitPrompt: refuse('submitPrompt'),
        awaitSeedAcknowledgement: refuse('awaitSeedAcknowledgement'),
        sessionHarness: refuse('sessionHarness'),
        turnEdges: () => Effect.succeed([]),
        conversationHistory: refuse('conversationHistory'),
      },
      panes: { closePane: refuse('closePane') },
      headless: {
        assertCanCreateProcess: refuse('assertCanCreateProcess'),
        allocate: refuse('allocate'),
        pin: refuse('pin'),
        unpin: refuse('unpin'),
        capture: refuse('capture'),
        terminate: refuse('terminate'),
        semanticError: () => null,
      },
    };
    const eventBus = {
      publish: () => Effect.void,
      subscribe: () => Effect.succeed({ take: Effect.never, unsubscribe: Effect.void }),
    };

    const operations = await Effect.runPromise(
      Scope.extend(
        makeWorkflowOperationService({
          operations: fixture.operations,
          runs: fixture.runs,
          payloads: fixture.payloads,
          adapters: adapters as never,
          eventBus: eventBus as never,
          runtimeId: 'runtime-prove',
        }),
        scope,
      ),
    );
    const waits = makeWaitResolver({
      runs: fixture.runs,
      payloads: fixture.payloads,
      operationRecords: fixture.operations,
      operations,
      catalog,
      turnEdges: () => Effect.succeed([]),
    });
    const dispatcher = makeDispatcher({
      runs: fixture.runs,
      payloads: fixture.payloads,
      operations,
      operationRecords: fixture.operations,
      catalog,
      owner: 'authoring-proof',
      ownerIncarnation: operations.incarnationId,
      reconcileExecution: operations.reconcileExecution,
      reconcileWait: waits.reconcileWait,
    });

    /**
     * The launch path as the interpreter layer wires it, fork included.
     *
     * `startWorkflow` no longer returns a placed run: it creates the run at
     * `environment_preparation` with a null destination and hands back the claimed attempt, and
     * `prepareEnvironment` is what commits a destination and moves the run to its graph entry. So
     * the launch is `startWorkflow` *then* preparation, joined — and the dispatcher below would find
     * nothing to drain without it, because it deliberately never claims this segment.
     *
     * Preparation is forked into this proof's scope and joined, mirroring `runPreparation` in
     * `interpreter.service.ts` rather than running it inline. The fork is the production behaviour
     * and this is the only place it executes anywhere: the engine test harness runs preparation
     * inline by a deliberate phase-7 decision, so `Effect.forkIn` has no other exercise. Running it
     * inline here would have left that wiring unproven while looking correct.
     *
     * Both dependency objects deliberately match `engine/test-support.ts`'s field for field,
     * including the shape of `surfaces` — a narrower or wider stub here would make this proof cover
     * something the engine suite does not.
     */
    const launchDeps: LaunchDeps = {
      runs: fixture.runs,
      registry,
      catalog,
      workspace: readers.workspace as never,
      workspaceService: owning.workspaceService as never,
      surfaceRepository: readers.surfaceRepository as never,
      surfaces: {
        ...readers.surfaceService,
        createSinglePaneSurface: owning.createSinglePaneSurface,
      } as never,
      owner: 'authoring-proof',
      // The incarnation the operation service owns, shared exactly as the layer shares it: the
      // launch claims the preparation attempt and preparation fences against that same claim, so
      // two different values here would make the launch's own claim look like somebody else's.
      ownerIncarnation: operations.incarnationId,
    };
    const prepDeps: PreparationDeps = {
      runs: fixture.runs,
      workspace: readers.workspace as never,
      workspaceService: owning.workspaceService as never,
      surfaceRepository: readers.surfaceRepository as never,
      surfaces: { createSinglePaneSurface: owning.createSinglePaneSurface } as never,
      owner: launchDeps.owner,
      ownerIncarnation: launchDeps.ownerIncarnation,
      // In the runtime this pokes the dispatcher awake. Here the drain loop below is explicit and
      // synchronous, so there is nothing to wake.
      poke: Effect.void,
    };
    const launched = await Effect.runPromise(
      startWorkflow(launchDeps, {
        workflowKey,
        inputs: { note: 'proved end to end' },
        origin: { worktreeId: placement.worktreeId, surfaceId: placement.surfaceId },
      }).pipe(
        Effect.tap((context) =>
          Effect.forkIn(prepareEnvironment(prepDeps, context), scope).pipe(
            Effect.flatMap(Fiber.join),
          ),
        ),
        // `interpreter.service.ts` destructures `{ run }` here; this script cannot, because `run`
        // is its own shell helper above.
        Effect.map((context) => context.run),
      ),
    );
    // The run must be pinned to the artifact the registry verified and published, not to some other
    // version the catalog happened to hold.
    if (launched.artifactHash !== input.artifactHash)
      throw new Error(
        `run adopted ${launched.artifactHash}, but the verified artifact was ${input.artifactHash}`,
      );

    /**
     * Preparation committed a destination, and it is the one the launch was placed in.
     *
     * Re-read rather than taken from `launched`, which is the pre-preparation record: a null
     * destination here would mean the fork never ran or never committed, and the drain below would
     * then fail for a reason that looks like an interpreter problem instead of a launch one.
     */
    const prepared = await Effect.runPromise(fixture.runs.findRun(launched.id));
    if (
      prepared?.destination.worktreeId !== placement.worktreeId ||
      prepared.destination.surfaceId !== placement.surfaceId
    )
      throw new Error(
        `preparation did not commit the placed destination: ${JSON.stringify(prepared?.destination)}`,
      );
    // Stricter than "allocated nothing", and worded for what it measures: `owning.calls` records
    // every owning-service call, allocating or not, so a future read-only preflight on this path
    // would trip it too. That is the assertion wanted here — a default placement should not need to
    // ask an owning service anything — but the message must not call a preflight an allocation.
    if (owning.calls.length > 0 || owning.deletions.length > 0)
      throw new Error(
        `a default launch must reach no owning service, but it called ${JSON.stringify([
          owning.calls,
          owning.deletions,
        ])}`,
      );
    log(
      'engine-launch',
      `run ${launched.id} created, pinned to ${launched.artifactHash}; preparation forked into the` +
        ` engine scope committed worktree ${prepared.destination.worktreeId}/surface` +
        ` ${prepared.destination.surfaceId} and allocated nothing`,
    );

    for (let pass = 0; pass < 10; pass += 1) {
      const summary = await Effect.runPromise(dispatcher.drainOnce);
      if (summary.advanced === 0) break;
    }

    const settled = await Effect.runPromise(fixture.runs.findRun(launched.id));
    if (settled?.status !== 'waiting')
      throw new Error(`expected the run to suspend, but it is ${settled?.status}`);
    if (settled.position.kind !== 'awaiting_wait')
      throw new Error(`expected an awaiting_wait position, got ${settled.position.kind}`);

    const frame = await Effect.runPromise(fixture.runs.findFrame(settled.activeFrameId!));
    const state = await Effect.runPromise(fixture.payloads.resolve(frame!.state!));
    if ((state as { note?: unknown }).note !== 'proved end to end')
      throw new Error(`root init did not carry the launch input: ${JSON.stringify(state)}`);

    const armed = await Effect.runPromise(fixture.runs.listArmedWaits(launched.id));
    if (armed.length !== 1 || armed[0]!.waitKind !== 'user_continue')
      throw new Error(`expected one armed user_continue wait, got ${JSON.stringify(armed)}`);

    log(
      'engine-run',
      `root init committed state ${JSON.stringify(state)}; run suspended at an armed` +
        ` ${armed[0]!.waitKind} wait (wait ${armed[0]!.id}) with nobody to answer it`,
    );
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    fixture.close();
  }
}

main().catch((error) => {
  process.stderr.write(`\nPROOF FAILED: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
