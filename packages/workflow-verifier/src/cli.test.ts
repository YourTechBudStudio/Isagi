import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  parseWorkflowBuildManifestJson,
  supportedWorkflowContractVersion,
  workflowBuildManifestVersion,
  workflowSdkPackage,
  workflowSdkVersion,
  workflowVerifierPackage,
  workflowVerifierVersion,
} from './receipt.js';
import { hashDescriptor, workflowStructureDescriptorVersion } from './structure.js';

/**
 * The CLI is exercised through its **built** entry, because its validation child is a plain Node
 * process that imports the verifier's sibling `structure.js` by file URL — the same resolution a
 * packed installation uses. The type comes from source, so typechecking needs no `dist`; the
 * package's `test` script builds first.
 */
const distCli = resolve(import.meta.dirname, '../dist/cli.js');
const { runProcess, verifyWorkflow } = (await import(
  pathToFileURL(distCli).href
)) as typeof import('./cli.js');

const canonicalFixture = resolve(import.meta.dirname, '../fixtures/minimal-workflow');
const receiptFile = 'dist/isagi-workflow-build.json';
const structureFile = 'dist/isagi-workflow-structure.json';

/**
 * A closed, hand-written artifact in the shape a built bundle has: plain-data brands, no imports.
 *
 * Writing it by hand keeps these tests independent of esbuild. The real build pipeline — and
 * everything downstream of it, up to a run suspended at its user gate — is proven separately by
 * `apps/runtime/scripts/prove-workflow-authoring.mts`, which packs these packages, installs them
 * into a copy of the canonical scaffold, builds and verifies it, loads it through the runtime
 * registry, and launches it through the interpreter.
 */
function artifact(options: { readonly checkpoint?: boolean; readonly graphKey?: string } = {}) {
  const key = options.graphKey ?? 'Minimal';
  const node = options.checkpoint
    ? `{ ...brand('checkpoint-node'), caption: 'Review the diff' }`
    : `{ ...brand('operation-node'), run: async () => ({ ...brand('operation-result'), type: 'complete' }) }`;
  return `const brand = (kind) => ({ isagiContract: 2, isagiKind: kind });
const graph = {
  ...brand('graph'),
  key: ${JSON.stringify(key)},
  title: 'Minimal workflow',
  init: () => ({ note: 'hello' }),
  state: { note: { ...brand('state-field'), reduce: (_c, u) => u } },
  entry: 'act',
  nodes: { act: ${node} },
  edges: { fromAct: { ...brand('edge'), from: 'act', to: ['done'], choose: () => ({ to: 'done' }) } },
  outcomes: { done: { ...brand('outcome'), kind: 'success', output: (s) => s.note } },
};
export default {
  ...brand('workflow'),
  command() { return { title: 'Minimal workflow', inputs: [] }; },
  validate() {},
  graph,
};
`;
}

// The canonical scaffold is the single source of truth. It ships without node_modules or dist, so
// the copy adds a prebuilt artifact the way an author's build would.
async function fixture(source = artifact()): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'isagi-verifier-test-'));
  await cp(canonicalFixture, root, {
    recursive: true,
    filter: (path) => {
      const top = path.slice(canonicalFixture.length + 1).split(sep)[0];
      return top !== 'node_modules' && top !== 'dist';
    },
  });
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist/index.js'), source);
  return root;
}

async function editPackageJson(root: string, edit: (pkg: Record<string, any>) => void) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  edit(pkg);
  await writeFile(join(root, 'package.json'), JSON.stringify(pkg, null, 2));
}

async function missing(root: string, relative: string): Promise<boolean> {
  try {
    await readFile(join(root, relative), 'utf8');
    return false;
  } catch {
    return true;
  }
}

test('verifies a workflow and writes a deterministic receipt', async () => {
  const root = await fixture();
  await verifyWorkflow(root);
  const built = await readFile(join(root, 'dist/index.js'), 'utf8');
  assert.doesNotMatch(built, /@yourtechbudstudio\/isagi-workflow-sdk/);
  const manifest = parseWorkflowBuildManifestJson(await readFile(join(root, receiptFile), 'utf8'));
  assert.equal(manifest.artifact.entry, 'dist/index.js');
  // The generated receipt must record the recommended pair and the supported contract/manifest
  // versions, binding the emitted manifest to the receipt constants.
  assert.equal(manifest.manifestVersion, workflowBuildManifestVersion);
  assert.equal(manifest.workflowContractVersion, supportedWorkflowContractVersion);
  assert.equal(manifest.sdk.name, workflowSdkPackage);
  assert.equal(manifest.sdk.version, workflowSdkVersion);
  assert.equal(manifest.verifier.name, workflowVerifierPackage);
  assert.equal(manifest.verifier.version, workflowVerifierVersion);
  const first = await readFile(join(root, receiptFile), 'utf8');
  await verifyWorkflow(root);
  assert.equal(await readFile(join(root, receiptFile), 'utf8'), first);
});

test('the receipt records the structure the artifact actually declares', async () => {
  const root = await fixture();
  await verifyWorkflow(root);
  const manifest = parseWorkflowBuildManifestJson(await readFile(join(root, receiptFile), 'utf8'));
  assert.equal(manifest.structure.descriptorVersion, workflowStructureDescriptorVersion);
  assert.equal(manifest.structure.rootGraphKey, 'Minimal');
  assert.equal(manifest.structure.graphCount, 1);
  assert.match(manifest.structure.sha256, /^[a-f0-9]{64}$/);
});

test('a different structure produces a different structure hash', async () => {
  const first = await fixture();
  await verifyWorkflow(first);
  const second = await fixture(artifact({ graphKey: 'Renamed' }));
  await verifyWorkflow(second);
  assert.notEqual(
    parseWorkflowBuildManifestJson(await readFile(join(first, receiptFile), 'utf8')).structure
      .sha256,
    parseWorkflowBuildManifestJson(await readFile(join(second, receiptFile), 'utf8')).structure
      .sha256,
  );
});

test('the structure description is written, and the receipt names its hash', async () => {
  const root = await fixture();
  await verifyWorkflow(root);
  const descriptor = JSON.parse(await readFile(join(root, structureFile), 'utf8'));
  assert.equal(descriptor.rootGraphKey, 'Minimal');
  assert.equal(descriptor.descriptorVersion, workflowStructureDescriptorVersion);
});

test('a checkpoint bundle verifies structurally, is refused, and gets no receipt', async () => {
  const root = await fixture(artifact({ checkpoint: true }));
  await assert.rejects(verifyWorkflow(root), (error: Error) => {
    assert.match(error.message, /cannot execute checkpoint capture/);
    assert.match(error.message, /Minimal\.act — Review the diff/);
    return true;
  });
  assert.ok(await missing(root, receiptFile), 'no receipt is written for an unlaunchable package');
  // The structure description is still written: it is what the author has to inspect.
  assert.equal(
    JSON.parse(await readFile(join(root, structureFile), 'utf8')).rootGraphKey,
    'Minimal',
  );
});

test('a failed verification removes a receipt an earlier success left behind', async () => {
  const root = await fixture();
  await verifyWorkflow(root);
  assert.ok(!(await missing(root, receiptFile)));
  // The artifact now declares a structure the verifier rejects.
  await writeFile(join(root, 'dist/index.js'), 'export default { command() {}, validate() {} };');
  await assert.rejects(verifyWorkflow(root), /failed the artifact check/);
  assert.ok(
    await missing(root, receiptFile),
    'a previous success must not stand as if it certified this attempt',
  );
});

test('a bundle that is not closed is rejected before the artifact is imported', async () => {
  const root = await fixture(`import 'some-package';\n${artifact()}`);
  await assert.rejects(verifyWorkflow(root), (error: Error) => {
    assert.match(error.message, /not a closed bundle/);
    assert.match(error.message, /still imports "some-package"/);
    return true;
  });
  assert.ok(await missing(root, receiptFile));
});

test('structural diagnostics name the code and the location', async () => {
  const root = await fixture(artifact().replace("to: ['done']", "to: ['nowhere']"));
  await assert.rejects(verifyWorkflow(root), (error: Error) => {
    assert.match(error.message, /\[edge_destination_unknown\]/);
    assert.match(error.message, /edge fromAct/);
    return true;
  });
});

test('a contract-version-1 bundle reports the real cause and never loads', async () => {
  const root = await fixture(artifact().replaceAll('isagiContract: 2', 'isagiContract: 1'));
  await assert.rejects(verifyWorkflow(root), (error: Error) => {
    assert.match(error.message, /\[unsupported_contract\]/);
    assert.match(error.message, /contract version 1; this release supports version 2/);
    return true;
  });
});

test('does not require tests/, tsconfig.json, or package scripts', async () => {
  // The verifier gates runtime loadability only. Quality gates (typecheck, tests) and build
  // conventions are the author's responsibility, so their absence must not fail verification.
  const root = await fixture();
  await rm(join(root, 'tests'), { recursive: true });
  await rm(join(root, 'tsconfig.json'));
  await editPackageJson(root, (pkg) => {
    pkg.scripts = {};
  });
  await verifyWorkflow(root);
  parseWorkflowBuildManifestJson(await readFile(join(root, receiptFile), 'utf8'));
});

test('requires src/ and a prebuilt dist/index.js with actionable messages', async () => {
  const missingSource = await fixture();
  await rm(join(missingSource, 'src'), { recursive: true });
  await assert.rejects(verifyWorkflow(missingSource), /A src\/ directory is required/);
  const missingBuild = await fixture();
  await rm(join(missingBuild, 'dist/index.js'));
  await assert.rejects(
    verifyWorkflow(missingBuild),
    /dist\/index\.js is missing\. Run the package's build script/,
  );
});

test('does not require package-manager metadata or a lockfile', async () => {
  const root = await fixture();
  await editPackageJson(root, (pkg) => {
    delete pkg.packageManager;
  });
  await verifyWorkflow(root);
  parseWorkflowBuildManifestJson(await readFile(join(root, receiptFile), 'utf8'));
});

test('states the pin rules with expected and found versions', async () => {
  const root = await fixture();
  await editPackageJson(root, (pkg) => {
    pkg.dependencies[workflowSdkPackage] = '^0.1.0';
  });
  await assert.rejects(
    verifyWorkflow(root),
    new RegExp(`must be exactly "${workflowSdkVersion}"; found "\\^0\\.1\\.0"`),
  );
});

test('rejects symlinked sources and states the rule', async () => {
  const root = await fixture();
  await symlink(join(root, 'src/index.ts'), join(root, 'src/linked.ts'));
  await assert.rejects(
    verifyWorkflow(root),
    /Symlinks are unsupported in workflow packages: src\/linked\.ts/,
  );
});

test('names package.json in JSON parse failures', async () => {
  const root = await fixture();
  await writeFile(join(root, 'package.json'), '{ not json');
  await assert.rejects(verifyWorkflow(root), /package\.json contains invalid JSON/);
});

test('names an export that is not a workflow definition', async () => {
  const root = await fixture();
  await writeFile(join(root, 'dist/index.js'), 'export default { command() { return {}; } };');
  await assert.rejects(verifyWorkflow(root), (error: Error) => {
    assert.match(error.message, /\[invalid_export\]/);
    assert.match(error.message, /must default-export the object returned by defineWorkflow\(\)/);
    return true;
  });
});

test('reports a throwing command() with its cause', async () => {
  const root = await fixture(
    artifact().replace(
      "command() { return { title: 'Minimal workflow', inputs: [] }; },",
      "command() { throw new Error('command exploded'); },",
    ),
  );
  await assert.rejects(verifyWorkflow(root), (error: Error) => {
    assert.match(error.message, /command\(\) threw when called with a minimal origin/);
    assert.match(error.message, /command exploded/);
    return true;
  });
});

test('pinpoints invalid command() inputs by index and key', async () => {
  const root = await fixture(
    artifact().replace('inputs: [] };', "inputs: [{ kind: 'select', key: 'k', label: 'K' }] };"),
  );
  await assert.rejects(
    verifyWorkflow(root),
    /inputs\[0\] \(key "k"\) is a select input and needs an options array/,
  );
});

test('tolerates workflow output on stdout during the artifact check', async () => {
  const root = await fixture(
    `console.log("import noise");\n${artifact().replace(
      "command() { return { title: 'Minimal workflow', inputs: [] }; },",
      "command() { console.log('command noise'); return { title: 'Minimal workflow', inputs: [] }; },",
    )}`,
  );
  await verifyWorkflow(root);
});

test('reports a bundle that exits the validation process', async () => {
  const root = await fixture('process.exit(0);\nexport default {};');
  await assert.rejects(verifyWorkflow(root), /terminated the validation process/);
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

test('a failed verification removes a receipt even when package.json cannot be read', async () => {
  // Receipt invalidation has to happen before anything that can fail, including reading the
  // package manifest. Otherwise malformed JSON leaves a previous success standing as if it
  // certified this attempt.
  const root = await fixture();
  await verifyWorkflow(root);
  assert.ok(!(await missing(root, receiptFile)));
  await writeFile(join(root, 'package.json'), '{ not json');
  await assert.rejects(verifyWorkflow(root), /package\.json contains invalid JSON/);
  assert.ok(await missing(root, receiptFile));
});

test('the generated descriptor is regenerated from the bundle, never read back as an input', async () => {
  const root = await fixture();
  await verifyWorkflow(root);
  const trusted = await readFile(join(root, structureFile), 'utf8');

  // Replace it with a different, perfectly valid descriptor describing another graph entirely.
  await writeFile(
    join(root, structureFile),
    `${JSON.stringify({
      descriptorVersion: 1,
      workflowContractVersion: 2,
      rootGraphKey: 'Impostor',
      graphs: [
        {
          key: 'Impostor',
          title: 'Impostor',
          stateFields: ['note'],
          entry: 'act',
          nodes: [{ id: 'act', kind: 'operation' }],
          edges: [{ id: 'fromAct', from: 'act', to: ['done'] }],
          outcomes: [{ id: 'done', kind: 'success' }],
        },
      ],
    })}\n`,
  );

  await verifyWorkflow(root);
  const regenerated = await readFile(join(root, structureFile), 'utf8');
  assert.equal(regenerated, trusted, 'the descriptor is re-derived from the artifact');

  // The receipt certifies the extracted descriptor, so the substituted file had no authority.
  const manifest = parseWorkflowBuildManifestJson(await readFile(join(root, receiptFile), 'utf8'));
  assert.equal(manifest.structure.rootGraphKey, 'Minimal');
  assert.equal(manifest.structure.sha256, hashDescriptor(JSON.parse(regenerated)));
});

test('an unparseable descriptor file is replaced rather than failing verification', async () => {
  const root = await fixture();
  await verifyWorkflow(root);
  const trusted = await readFile(join(root, structureFile), 'utf8');
  await writeFile(join(root, structureFile), 'not json at all');
  await verifyWorkflow(root);
  assert.equal(await readFile(join(root, structureFile), 'utf8'), trusted);
});

test('a bundle whose graph key is unusable is refused and gets no receipt', async () => {
  // The extractor collects graphs by object identity, so a malformed key is a rejection rather
  // than a graph that quietly disappears from the descriptor.
  const root = await fixture(artifact().replace('key: "Minimal",', 'key: 7,'));
  await assert.rejects(verifyWorkflow(root), (error: Error) => {
    assert.match(error.message, /\[invalid_identifier\]/);
    return true;
  });
  assert.ok(await missing(root, receiptFile));
});
