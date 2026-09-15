import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  hashArtifact,
  hashWorkflowInputs,
  serializeWorkflowBuildManifest,
  supportedWorkflowContractVersion,
  workflowBuildManifestVersion,
  workflowSdkPackage,
  workflowVerifierPackage,
} from '@yourtechbudstudio/isagi-workflow-verifier/receipt';
import {
  describeWorkflowModule,
  hashDescriptor,
  workflowStructureDescriptorVersion,
} from '@yourtechbudstudio/isagi-workflow-verifier/structure';
import { Effect, Either, Layer, Ref } from 'effect';

import { DataDirectory, type IsagiDataDirectory } from '../../persistence/index.js';
import { makeTestDataDirectory } from '../../persistence/test-support.js';
import { defaultRuntimeConfig, RuntimeConfig } from '../../runtime-config/index.js';
import { scanWorkflowSource } from './discovery.js';
import { WorkflowLoadError } from './loader.js';
import {
  createFilesystemWorkflowRegistry,
  WorkflowRegistry,
  WorkflowRegistryError,
  WorkflowRegistryLive,
  type WorkflowRegistryContext,
  type WorkflowRegistryService,
} from './registry.js';

test('live registry captures configured sources once at layer construction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'isagi-workflow-startup-config-'));
  try {
    const initial = join(root, 'initial');
    const changed = join(root, 'changed');
    await writePackage(join(initial, 'initial-only'), artifact);
    await writePackage(join(changed, 'changed-only'), artifact);
    const configRef = await Effect.runPromise(
      Ref.make({
        ...defaultRuntimeConfig,
        workflows: { additionalDirectories: [initial] },
      }),
    );
    const registryLayer = WorkflowRegistryLive.pipe(
      Layer.provide(Layer.succeed(DataDirectory, { paths: dataDirectoryPaths(root) })),
      Layer.provide(
        Layer.succeed(RuntimeConfig, {
          get: Ref.get(configRef),
          acceptHarnessPolicy: () => Effect.die('config mutation is not used'),
        }),
      ),
    );

    const keys = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* WorkflowRegistry;
        yield* Ref.set(configRef, {
          ...defaultRuntimeConfig,
          workflows: { additionalDirectories: [changed] },
        });
        return (yield* registry.discover()).entries.map((entry) => entry.workflowKey);
      }).pipe(Effect.provide(registryLayer)),
    );

    assert.deepEqual(keys, ['initial-only']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * A bundle, written the way a real one arrives: plain branded data, not an SDK import.
 *
 * An author's bundle embeds its own copy of the SDK, so the objects the loader inspects are never
 * the runtime's own instances. Writing the brands out literally here is what keeps these tests
 * honest about that — recognition has to work on plain data or it does not work at all.
 */
function bundleSource(input: { readonly graphKey: string; readonly nodes: string }): string {
  return `const brand = (kind) => ({ isagiContract: 2, isagiKind: kind });
export default {
  ...brand('workflow'),
  command: () => ({ title: 'Packaged workflow' }),
  validate: () => {},
  graph: {
    ...brand('graph'),
    key: '${input.graphKey}',
    title: 'Packaged workflow',
    init: () => ({ done: false }),
    state: { done: { ...brand('state-field'), reduce: (_c, u) => u } },
    entry: 'work',
    nodes: ${input.nodes},
    edges: {
      'work-out': { ...brand('edge'), from: 'work', to: ['finished'], choose: () => ({ to: 'finished' }) }
    },
    outcomes: {
      finished: { ...brand('outcome'), kind: 'success', output: (state) => state }
    }
  }
};
`;
}

const operationNodes = `{ work: { ...brand('operation-node'), run: async () => ({ ...brand('operation-result'), type: 'complete' }) } }`;

const artifact = bundleSource({ graphKey: 'packaged-workflow', nodes: operationNodes });

/** A bundle that validates structurally and still cannot be launched by this release. */
const checkpointArtifact = bundleSource({
  graphKey: 'checkpoint-workflow',
  nodes: `{ work: { ...brand('checkpoint-node'), caption: 'Review before continuing' } }`,
});

/** A bundle whose entry node is not declared: structurally invalid, with a locating diagnostic. */
const invalidStructureArtifact = bundleSource({
  graphKey: 'broken-workflow',
  nodes: operationNodes,
}).replace("entry: 'work'", "entry: 'missing'");

test('loads a verified standalone package and reuses its content-addressed pin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'isagi-workflow-loader-'));
  try {
    const workflows = join(root, 'workflows');
    const cache = join(root, 'cache');
    await writePackage(join(workflows, 'packaged'), artifact);
    const registry = createFilesystemWorkflowRegistry(workflows, cache);
    const latest = await Effect.runPromise(discoverAndLoad(registry, 'packaged'));
    assert.ok(latest);
    assert.equal((await latest.definition.command({} as never)).title, 'Packaged workflow');
    await rm(join(workflows, 'packaged', 'node_modules'), { recursive: true, force: true });
    const pinned = await Effect.runPromise(registry.loadPinned(latest.artifactHash, 'packaged'));
    assert.equal((await pinned.definition.command({} as never)).title, 'Packaged workflow');
    assert.equal(await readFile(join(cache, latest.artifactHash, 'index.mjs'), 'utf8'), artifact);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reloads a newly verified artifact while the previous pin remains loadable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'isagi-workflow-reload-'));
  try {
    const workflows = join(root, 'workflows');
    const cache = join(root, 'cache');
    const packageRoot = join(workflows, 'packaged');
    await writePackage(packageRoot, artifact);
    const registry = createFilesystemWorkflowRegistry(workflows, cache);
    const first = await Effect.runPromise(discoverAndLoad(registry, 'packaged'));
    assert.ok(first);
    const changed = artifact.replace('Packaged workflow', 'Changed workflow');
    await writePackage(packageRoot, changed);
    const second = await Effect.runPromise(discoverAndLoad(registry, 'packaged'));
    assert.ok(second);
    assert.notEqual(first.artifactHash, second.artifactHash);
    assert.equal((await second.definition.command({} as never)).title, 'Changed workflow');
    const pinned = await Effect.runPromise(registry.loadPinned(first.artifactHash, 'packaged'));
    assert.equal((await pinned.definition.command({} as never)).title, 'Packaged workflow');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reports stable reasons for legacy, stale, tampered, and missing pinned artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'isagi-workflow-failures-'));
  try {
    const workflows = join(root, 'workflows');
    const cache = join(root, 'cache');
    const registry = createFilesystemWorkflowRegistry(workflows, cache);
    await mkdir(join(workflows, 'legacy'), { recursive: true });
    await writeFile(join(workflows, 'legacy', 'index.ts'), 'export default {};\n');
    assert.equal(await reason(discoverAndLoad(registry, 'legacy')), 'missing_build');

    const staleRoot = join(workflows, 'stale');
    await writePackage(staleRoot, artifact);
    await writeFile(join(staleRoot, 'src', 'index.ts'), '// changed\n');
    assert.equal(await reason(discoverAndLoad(registry, 'stale')), 'stale_source');

    const tamperedRoot = join(workflows, 'tampered');
    await writePackage(tamperedRoot, artifact);
    await writeFile(join(tamperedRoot, 'dist', 'index.js'), `${artifact}// tampered\n`);
    assert.equal(await reason(discoverAndLoad(registry, 'tampered')), 'artifact_tampered');

    assert.equal(
      await reason(registry.loadPinned('f'.repeat(64), 'missing')),
      'pinned_artifact_unavailable',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preserves project precedence without writing under the project root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'isagi-workflow-precedence-'));
  try {
    const workflows = join(root, 'global');
    const project = join(root, 'project');
    const projectWorkflows = join(project, '.isagi', 'workflows');
    const cache = join(root, 'cache');
    await writePackage(join(workflows, 'shared'), artifact);
    await writePackage(join(projectWorkflows, 'shared'), artifact.replace('Packaged', 'Project'));
    const registry = createFilesystemWorkflowRegistry(workflows, cache);
    const loaded = await Effect.runPromise(
      discoverAndLoad(registry, 'shared', { projectId: 1, projectRoot: project }),
    );
    assert.ok(loaded);
    assert.equal((await loaded.definition.command({} as never)).title, 'Project workflow');
    await assert.rejects(readFile(join(projectWorkflows, '.cache')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('applies core, configured-array, and project precedence in source order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'isagi-workflow-configured-precedence-'));
  try {
    const core = join(root, 'core');
    const lowAdditional = join(root, 'additional-low');
    const highAdditional = join(root, 'additional-high');
    const project = join(root, 'project');
    await writePackage(join(core, 'shared'), artifact.replace('Packaged', 'Core'));
    await writePackage(join(lowAdditional, 'shared'), artifact.replace('Packaged', 'Low'));
    await writePackage(join(highAdditional, 'shared'), artifact.replace('Packaged', 'High'));
    await writePackage(
      join(project, '.isagi', 'workflows', 'shared'),
      artifact.replace('Packaged', 'Project'),
    );
    const registry = createFilesystemWorkflowRegistry(core, join(root, 'cache'), {
      additionalDirectories: [lowAdditional, highAdditional],
    });

    const withoutProject = await Effect.runPromise(discoverAndLoad(registry, 'shared'));
    const withProject = await Effect.runPromise(
      discoverAndLoad(registry, 'shared', { projectId: 1, projectRoot: project }),
    );

    assert.equal((await withoutProject.definition.command({} as never)).title, 'High workflow');
    assert.equal((await withProject.definition.command({} as never)).title, 'Project workflow');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('deduplicates normalized sources and preserves the highest-priority occurrence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'isagi-workflow-source-dedupe-'));
  try {
    const core = join(root, 'workflows');
    await writePackage(join(core, 'shared'), artifact);
    const scans: string[] = [];
    const registry = createFilesystemWorkflowRegistry(core, join(root, 'cache'), {
      additionalDirectories: [join(core, 'nested', '..'), core],
      scanSource: (source) => {
        scans.push(`${source.kind}:${source.rootPath}`);
        return scanWorkflowSource(source);
      },
    });

    await Effect.runPromise(registry.discover());

    assert.deepEqual(scans, [`additional:${core}`]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('warns once for a missing explicitly configured source and stays silent for implicit roots', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'isagi-workflow-missing-source-'));
  try {
    const warn = t.mock.method(console, 'warn', () => {});
    const configured = join(root, 'configured-missing');
    const registry = createFilesystemWorkflowRegistry(
      join(root, 'core-missing'),
      join(root, 'cache'),
      {
        additionalDirectories: [configured],
      },
    );

    await Effect.runPromise(registry.discover());
    await Effect.runPromise(registry.discover());

    assert.equal(warn.mock.callCount(), 1);
    assert.deepEqual(warn.mock.calls[0]?.arguments[1], {
      operation: 'workflow.discover.scan_source',
      workflowSourceDirectory: configured,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('retains configured missing-path warning policy when a project source wins deduplication', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'isagi-workflow-deduped-warning-'));
  try {
    const project = join(root, 'project');
    const projectWorkflows = join(project, '.isagi', 'workflows');
    const warn = t.mock.method(console, 'warn', () => {});
    const registry = createFilesystemWorkflowRegistry(
      join(root, 'core-missing'),
      join(root, 'cache'),
      {
        additionalDirectories: [projectWorkflows],
      },
    );

    await Effect.runPromise(registry.discover({ projectId: 1, projectRoot: project }));

    assert.equal(warn.mock.callCount(), 1);
    assert.equal(warn.mock.calls[0]?.arguments[1]?.workflowSourceDirectory, projectWorkflows);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('maps injected scan failures through the registry with typed source context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'isagi-workflow-injected-scan-failure-'));
  try {
    const configured = join(root, 'configured');
    const registry = createFilesystemWorkflowRegistry(join(root, 'core'), join(root, 'cache'), {
      additionalDirectories: [configured],
      scanSource: (source) => {
        if (source.kind === 'additional')
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return [];
      },
    });

    const result = await Effect.runPromise(registry.discover().pipe(Effect.either));

    assert.ok(Either.isLeft(result));
    assert.ok(result.left instanceof WorkflowRegistryError);
    assert.equal(result.left.code, 'scan_failed');
    assert.equal(result.left.sourceKind, 'additional');
    assert.equal(result.left.workflowSourceDirectory, configured);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('retains malformed children as blocking winners without lower-priority fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'isagi-workflow-malformed-precedence-'));
  try {
    const workflows = join(root, 'global');
    const project = join(root, 'project');
    const projectWorkflows = join(project, '.isagi', 'workflows');
    const cache = join(root, 'cache');
    await writePackage(join(workflows, 'file-winner'), artifact);
    await writePackage(join(workflows, 'symlink-winner'), artifact);
    await mkdir(projectWorkflows, { recursive: true });
    await writeFile(join(projectWorkflows, 'file-winner'), 'malformed override\n');
    await symlink(join(workflows, 'symlink-winner'), join(projectWorkflows, 'symlink-winner'));

    const registry = createFilesystemWorkflowRegistry(workflows, cache);
    const context = { projectId: 1, projectRoot: project };
    const discovery = await Effect.runPromise(registry.discover(context));

    assert.deepEqual(
      discovery.entries.map((entry) => entry.workflowKey),
      ['file-winner', 'symlink-winner'],
    );
    assert.equal(
      await reason(registry.loadDiscovered(discovery.find('file-winner')!)),
      'invalid_package',
    );
    assert.equal(
      await reason(registry.loadDiscovered(discovery.find('symlink-winner')!)),
      'invalid_package',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not rediscover or fall back when a discovered winner disappears before loading', async () => {
  const root = await mkdtemp(join(tmpdir(), 'isagi-workflow-disappearing-winner-'));
  try {
    const workflows = join(root, 'global');
    const project = join(root, 'project');
    const projectWinner = join(project, '.isagi', 'workflows', 'shared');
    await writePackage(join(workflows, 'shared'), artifact);
    await writePackage(projectWinner, artifact.replace('Packaged', 'Project'));
    const registry = createFilesystemWorkflowRegistry(workflows, join(root, 'cache'));
    const discovery = await Effect.runPromise(
      registry.discover({ projectId: 1, projectRoot: project }),
    );
    const shared = discovery.find('shared');
    assert.ok(shared);

    await rm(projectWinner, { recursive: true });

    assert.equal(await reason(registry.loadDiscovered(shared)), 'invalid_package');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('discovers lone file and symlink children as malformed package descriptors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'isagi-workflow-malformed-children-'));
  try {
    const workflows = join(root, 'workflows');
    const target = join(root, 'target');
    await mkdir(workflows, { recursive: true });
    await writeFile(join(workflows, 'file-child'), 'malformed package\n');
    await mkdir(target);
    await symlink(target, join(workflows, 'symlink-child'));

    const registry = createFilesystemWorkflowRegistry(workflows, join(root, 'cache'));
    const discovery = await Effect.runPromise(registry.discover());

    assert.deepEqual(
      discovery.entries.map((entry) => entry.workflowKey),
      ['file-child', 'symlink-child'],
    );
    for (const entry of discovery.entries) {
      assert.equal(await reason(registry.loadDiscovered(entry)), 'invalid_package');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a complete discovery when a later source cannot be scanned', async () => {
  const root = await mkdtemp(join(tmpdir(), 'isagi-workflow-source-failure-'));
  try {
    const workflows = join(root, 'global');
    const project = join(root, 'project');
    await writePackage(join(workflows, 'available'), artifact);
    await mkdir(join(project, '.isagi'), { recursive: true });
    await writeFile(join(project, '.isagi', 'workflows'), 'not a collection root\n');
    const registry = createFilesystemWorkflowRegistry(workflows, join(root, 'cache'));

    const result = await Effect.runPromise(
      registry.discover({ projectId: 1, projectRoot: project }).pipe(Effect.either),
    );

    assert.ok(Either.isLeft(result));
    assert.ok(result.left instanceof WorkflowRegistryError);
    assert.equal(result.left.code, 'scan_failed');
    assert.equal(result.left.sourceKind, 'project');
    assert.equal(result.left.workflowSourceDirectory, join(project, '.isagi', 'workflows'));
    assert.equal(
      result.left.message,
      `Could not scan workflow directory: ${join(project, '.isagi', 'workflows')}.`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('logs a discovered project collision once per registry instance and context', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'isagi-workflow-shadow-log-'));
  try {
    const workflows = join(root, 'global');
    const project = join(root, 'project');
    await writePackage(join(workflows, 'shared'), artifact);
    await writePackage(join(project, '.isagi', 'workflows', 'shared'), artifact);
    const info = t.mock.method(console, 'info', () => {});
    const registry = createFilesystemWorkflowRegistry(workflows, join(root, 'cache'));
    const context = { projectId: 1, projectRoot: project };

    await Effect.runPromise(registry.discover(context));
    await Effect.runPromise(registry.discover(context));

    assert.equal(info.mock.callCount(), 1);
    assert.deepEqual(info.mock.calls[0]?.arguments[1], {
      workflowKey: 'shared',
      winningSourceKind: 'project',
      workflowPackageDirectory: join(project, '.isagi', 'workflows', 'shared'),
      shadowedWorkflowPackageDirectories: [join(workflows, 'shared')],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('distinguishes unsupported manifest, unsupported contract, and invalid package pins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'isagi-workflow-compatibility-'));
  try {
    const workflows = join(root, 'workflows');
    const cache = join(root, 'cache');
    const registry = createFilesystemWorkflowRegistry(workflows, cache);

    for (const [key, field, value, expected] of [
      // The versions this release replaced. An old package must be rebuilt, never interpreted
      // loosely, so both produce their own reason rather than a generic parse failure.
      ['manifest', 'manifestVersion', 1, 'unsupported_manifest'],
      ['contract', 'workflowContractVersion', 1, 'unsupported_contract'],
    ] as const) {
      const packageRoot = join(workflows, key);
      await writePackage(packageRoot, artifact);
      const manifestPath = join(packageRoot, 'dist', 'isagi-workflow-build.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
      manifest[field] = value;
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      assert.equal(await reason(discoverAndLoad(registry, key)), expected);
    }

    const invalidRoot = join(workflows, 'invalid-package');
    await writePackage(invalidRoot, artifact);
    const packagePath = join(invalidRoot, 'package.json');
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
      dependencies: Record<string, string>;
    };
    packageJson.dependencies[workflowSdkPackage] = '^0.0.1';
    await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    const invalid = await failure(discoverAndLoad(registry, 'invalid-package'));
    assert.equal(invalid.reason, 'invalid_package');
    assert.match(invalid.message, /dependencies.*exact semver/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent latest loads publish one valid immutable artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'isagi-workflow-concurrent-'));
  try {
    const workflows = join(root, 'workflows');
    const cache = join(root, 'cache');
    await writePackage(join(workflows, 'packaged'), artifact);
    const registry = createFilesystemWorkflowRegistry(workflows, cache);
    const loaded = await Promise.all(
      Array.from({ length: 8 }, () => Effect.runPromise(discoverAndLoad(registry, 'packaged'))),
    );
    assert.ok(loaded.every((entry) => entry?.artifactHash === loaded[0]?.artifactHash));
    const hash = loaded[0]?.artifactHash;
    assert.ok(hash);
    assert.equal(hashArtifact(await readFile(join(cache, hash, 'index.mjs'))), hash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses a structurally invalid bundle and says which node is wrong', async () => {
  const root = await mkdtemp(join(tmpdir(), 'isagi-workflow-invalid-structure-'));
  try {
    const workflows = join(root, 'workflows');
    const registry = createFilesystemWorkflowRegistry(workflows, join(root, 'cache'));
    await writePackage(join(workflows, 'broken'), invalidStructureArtifact);

    const error = await failure(discoverAndLoad(registry, 'broken'));
    assert.equal(error.reason, 'invalid_structure');
    // The diagnostics are the point: an author needs to know *which* registration is wrong, and the
    // API and inspector show exactly this list.
    assert.ok(error.diagnostics && error.diagnostics.length > 0);
    assert.ok(
      error.diagnostics.some((diagnostic) => diagnostic.code === 'missing_entry'),
      `Expected a missing_entry diagnostic, got ${JSON.stringify(error.diagnostics)}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses a bundle whose receipt describes a different structure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'isagi-workflow-structure-mismatch-'));
  try {
    const workflows = join(root, 'workflows');
    const registry = createFilesystemWorkflowRegistry(workflows, join(root, 'cache'));
    // The receipt is internally well-formed and signed off; only its structure hash is a lie. The
    // loader re-derives the structure from the bytes that will actually execute, so the edit cannot
    // make one artifact hash pin a different graph.
    await writePackage(join(workflows, 'mismatched'), artifact, { sha256: 'b'.repeat(64) });

    assert.equal(await reason(discoverAndLoad(registry, 'mismatched')), 'structure_mismatch');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses to load a checkpoint bundle that is valid but not launchable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'isagi-workflow-checkpoint-'));
  try {
    const workflows = join(root, 'workflows');
    const registry = createFilesystemWorkflowRegistry(workflows, join(root, 'cache'));
    await writePackage(join(workflows, 'checkpointed'), checkpointArtifact);

    // Structurally valid — it reaches the capability report rather than failing validation — and
    // still refused, because this release cannot execute a checkpoint node. That is what keeps the
    // extension seam real without letting it run half-implemented.
    const error = await failure(discoverAndLoad(registry, 'checkpointed'));
    assert.equal(error.reason, 'unsupported_capability');
    assert.match(error.message, /checkpoint/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('exposes every declared graph as a live object addressable by its descriptor key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'isagi-workflow-graph-map-'));
  try {
    const workflows = join(root, 'workflows');
    const registry = createFilesystemWorkflowRegistry(workflows, join(root, 'cache'));
    await writePackage(join(workflows, 'packaged'), artifact);

    const loaded = await Effect.runPromise(discoverAndLoad(registry, 'packaged'));

    // The two halves must agree: the descriptor is what the inspector reads, the map is what the
    // interpreter executes, and a key in one that is missing from the other is a run that cannot
    // resolve its own frame.
    assert.deepEqual(
      [...loaded.graphs.keys()].sort(),
      loaded.descriptor.graphs.map((graph) => graph.key).sort(),
    );
    assert.equal(loaded.graphs.get(loaded.descriptor.rootGraphKey), loaded.definition.graph);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function reason(effect: Effect.Effect<unknown, unknown>) {
  return (await failure(effect)).reason;
}

function discoverAndLoad(
  registry: WorkflowRegistryService,
  workflowKey: string,
  context?: WorkflowRegistryContext,
) {
  return Effect.gen(function* () {
    const discovery = yield* registry.discover(context);
    const entry = discovery.find(workflowKey);
    assert.ok(entry, `Expected workflow '${workflowKey}' to be discovered.`);
    return yield* registry.loadDiscovered(entry);
  });
}

async function failure(effect: Effect.Effect<unknown, unknown>) {
  const result = await Effect.runPromise(Effect.either(effect));
  assert.equal(Either.isLeft(result), true);
  assert.ok(Either.isLeft(result) && result.left instanceof WorkflowLoadError);
  return result.left;
}

async function writePackage(
  root: string,
  artifactText: string,
  structureOverride?: { readonly sha256: string } | undefined,
) {
  const packageJson = `${JSON.stringify(
    {
      name: 'fixture-workflow',
      private: true,
      dependencies: { [workflowSdkPackage]: '0.1.0' },
      devDependencies: { [workflowVerifierPackage]: '0.1.0' },
    },
    null,
    2,
  )}\n`;
  const inputs = [
    { path: 'src/index.ts', bytes: Buffer.from('// source\n') },
    { path: 'tests/index.test.ts', bytes: Buffer.from('// test\n') },
    { path: 'package.json', bytes: Buffer.from(packageJson) },
    { path: 'tsconfig.json', bytes: Buffer.from('{}\n') },
  ];
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'tests'), { recursive: true });
  await mkdir(join(root, 'dist'), { recursive: true });
  for (const input of inputs) await writeFile(join(root, input.path), input.bytes);
  await writeFile(join(root, 'dist', 'index.js'), artifactText);
  await writeFile(
    join(root, 'dist', 'isagi-workflow-build.json'),
    serializeWorkflowBuildManifest({
      manifestVersion: workflowBuildManifestVersion,
      workflowContractVersion: supportedWorkflowContractVersion,
      sdk: { name: workflowSdkPackage, version: '0.1.0' },
      verifier: { name: workflowVerifierPackage, version: '0.1.0' },
      source: { sha256: hashWorkflowInputs(inputs) },
      artifact: { entry: 'dist/index.js', sha256: hashArtifact(Buffer.from(artifactText)) },
      // Derived from the bundle that was actually written, the same way the verifier derives it, so
      // the receipt describes this graph rather than a hand-maintained guess about it.
      structure: await describeBundleStructure(root, artifactText, structureOverride),
    }),
  );
}

/**
 * The receipt's structure block, derived by importing the bundle exactly as the loader will.
 *
 * `structureOverride` exists for the tamper case: it is what an edited receipt looks like, and the
 * loader must reject it because the structure it re-derives from the bytes disagrees.
 */
async function describeBundleStructure(
  root: string,
  artifactText: string,
  structureOverride?: { readonly sha256: string } | undefined,
) {
  const modulePath = join(root, 'dist', `structure-probe-${randomUUID()}.mjs`);
  await writeFile(modulePath, artifactText);
  try {
    const loaded: unknown = await import(pathToFileURL(modulePath).href);
    const described = describeWorkflowModule(loaded);
    // A real verifier never issues a receipt for a bundle it could not describe, so an invalid
    // bundle can only reach the loader carrying a receipt that *claims* a valid structure — bytes
    // edited after verification, or a receipt copied from elsewhere. The claim below is what that
    // looks like, and the loader has to refuse it on the structure it re-derives, not on the claim.
    return {
      descriptorVersion: workflowStructureDescriptorVersion,
      sha256:
        structureOverride?.sha256 ??
        (described.ok ? hashDescriptor(described.descriptor) : 'c'.repeat(64)),
      rootGraphKey: described.ok ? described.descriptor.rootGraphKey : 'claimed-graph',
      graphCount: described.ok ? described.descriptor.graphs.length : 1,
    } as const;
  } finally {
    await rm(modulePath, { force: true });
  }
}

function dataDirectoryPaths(root: string): IsagiDataDirectory {
  return makeTestDataDirectory(root).paths;
}
