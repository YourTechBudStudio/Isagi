import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  hashArtifact,
  hashWorkflowInputs,
  isWorkflowSourcePath,
  parseWorkflowBuildManifestJson,
  workflowBuildManifestVersion,
  supportedWorkflowContractVersion,
  workflowSdkPackage,
  workflowVerifierPackage,
  type HashInput,
  type WorkflowBuildManifest,
} from '@yourtechbudstudio/isagi-workflow-verifier/receipt';
import {
  describeCapabilities,
  describeWorkflowModule,
  hashDescriptor,
  type StructureDiagnostic,
  type WorkflowStructureDescriptor,
} from '@yourtechbudstudio/isagi-workflow-verifier/structure';
import { Data, Effect } from 'effect';

import type { WorkflowLoadFailureReason } from '@isagi/contracts';

import type { GraphDefinition, WorkflowDefinition } from '../types.js';

export class WorkflowLoadError extends Data.TaggedError('WorkflowLoadError')<{
  readonly reason: WorkflowLoadFailureReason;
  readonly message: string;
  readonly workflowKey?: string | undefined;
  readonly artifactHash?: string | undefined;
  /** Which node, edge or subgraph registration is wrong, when the structure is what failed. */
  readonly diagnostics?: readonly StructureDiagnostic[] | undefined;
  readonly cause?: unknown;
}> {}

/**
 * An imported, structurally verified artifact.
 *
 * `graphs` is how the interpreter turns a saved `graph_key` back into executable code without
 * re-entering discovery, and `descriptor` is the same structure as data — which is what lets the
 * inspector describe a version it must never import.
 */
export interface LoadedWorkflowArtifact {
  readonly artifactHash: string;
  readonly definition: AnyWorkflowDefinition;
  readonly descriptor: WorkflowStructureDescriptor;
  readonly graphs: ReadonlyMap<string, AnyGraphDefinition>;
}

// The loader is contract-checked, not type-checked: it inspects bundles compiled against their own
// copy of the SDK, so the author's real parameter and state types are gone by the time these
// objects arrive. `describeWorkflowModule` is what establishes the shape.
export type AnyWorkflowDefinition = WorkflowDefinition<Record<string, unknown>, unknown>;
export type AnyGraphDefinition = GraphDefinition<unknown, unknown, unknown, unknown>;

export type WorkflowDefinitionCache = Map<string, Promise<LoadedWorkflowArtifact>>;

const exactSemver =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function validateAndPublishWorkflowPackage(input: {
  readonly workflowKey: string;
  readonly packageRoot: string;
  readonly cacheRoot: string;
  readonly definitionCache: WorkflowDefinitionCache;
}) {
  return Effect.tryPromise({
    try: async () => {
      const packageStat = await lstat(input.packageRoot).catch((cause) => {
        throw failure(
          'invalid_package',
          input,
          'Workflow package directory is unavailable.',
          cause,
        );
      });
      if (packageStat.isSymbolicLink() || !packageStat.isDirectory()) {
        throw failure(
          'invalid_package',
          input,
          'Workflow package root must be a regular directory.',
        );
      }
      const manifestPath = join(input.packageRoot, 'dist', 'isagi-workflow-build.json');
      let manifestText: string;
      try {
        manifestText = await readFile(manifestPath, 'utf8');
      } catch (cause) {
        throw failure('missing_build', input, 'A verified workflow build is required.', cause);
      }
      const manifest = parseManifest(manifestText, input);
      await validatePackageMetadata(input.packageRoot, manifest, input);
      const sourceInputs = await readSourceInputs(input.packageRoot, input);
      if (hashWorkflowInputs(sourceInputs) !== manifest.source.sha256) {
        throw failure('stale_source', input, 'Workflow source differs from the verified build.');
      }
      const artifactPath = containedPath(input.packageRoot, manifest.artifact.entry, input);
      const artifactBytes = await readRegularFile(artifactPath, input, 'artifact_tampered');
      if (hashArtifact(artifactBytes) !== manifest.artifact.sha256) {
        throw failure(
          'artifact_tampered',
          input,
          'Workflow artifact does not match its build manifest.',
        );
      }
      await publishArtifact(input.cacheRoot, manifest.artifact.sha256, artifactBytes, input);
      return await importCachedArtifact(
        input.cacheRoot,
        manifest.artifact.sha256,
        { ...input, structureHash: manifest.structure.sha256 },
        input.definitionCache,
      );
    },
    catch: (cause) => normalizeFailure(cause, input),
  });
}

export function loadPinnedWorkflowArtifact(input: {
  readonly artifactHash: string;
  readonly cacheRoot: string;
  readonly workflowKey?: string | undefined;
  readonly definitionCache: WorkflowDefinitionCache;
}) {
  return Effect.tryPromise({
    try: async () => {
      if (!/^[a-f0-9]{64}$/.test(input.artifactHash)) {
        throw failure(
          'pinned_artifact_unavailable',
          input,
          'Workflow run has an invalid artifact pin.',
        );
      }
      const path = artifactCachePath(input.cacheRoot, input.artifactHash);
      const bytes = await readRegularFile(path, input, 'pinned_artifact_unavailable');
      if (hashArtifact(bytes) !== input.artifactHash) {
        throw failure('pinned_artifact_unavailable', input, 'Pinned workflow artifact is corrupt.');
      }
      // The same three structural steps run on the pinned bytes, so a corrupt or
      // capability-invalid pin fails closed instead of executing.
      return await importCachedArtifact(
        input.cacheRoot,
        input.artifactHash,
        input,
        input.definitionCache,
      );
    },
    catch: (cause) => normalizeFailure(cause, input, 'pinned_artifact_unavailable'),
  });
}

function parseManifest(text: string, input: { readonly workflowKey: string }) {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw failure('invalid_manifest', input, 'Workflow build manifest is not valid JSON.', cause);
  }
  if (typeof raw === 'object' && raw !== null) {
    const version = (raw as Record<string, unknown>).manifestVersion;
    if (version !== workflowBuildManifestVersion) {
      throw failure(
        'unsupported_manifest',
        input,
        `Unsupported workflow manifest version: ${String(version)}.`,
      );
    }
    const contract = (raw as Record<string, unknown>).workflowContractVersion;
    if (contract !== supportedWorkflowContractVersion) {
      throw failure(
        'unsupported_contract',
        input,
        `Unsupported workflow contract version: ${String(contract)}.`,
      );
    }
  }
  try {
    return parseWorkflowBuildManifestJson(text);
  } catch (cause) {
    throw failure('invalid_manifest', input, 'Workflow build manifest is invalid.', cause);
  }
}

async function validatePackageMetadata(
  root: string,
  manifest: WorkflowBuildManifest,
  input: { readonly workflowKey: string },
) {
  let packageJson: Record<string, unknown>;
  try {
    packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
  } catch (cause) {
    throw failure('invalid_package', input, 'Workflow package.json is missing or invalid.', cause);
  }
  const dependencies = record(packageJson.dependencies);
  const devDependencies = record(packageJson.devDependencies);
  const sdkVersion = dependencies[workflowSdkPackage];
  const verifierVersion = devDependencies[workflowVerifierPackage];
  requireRecordedPin('dependencies', workflowSdkPackage, sdkVersion, manifest.sdk.version, input);
  requireRecordedPin(
    'devDependencies',
    workflowVerifierPackage,
    verifierVersion,
    manifest.verifier.version,
    input,
  );
}

function requireRecordedPin(
  section: 'dependencies' | 'devDependencies',
  packageName: string,
  declared: unknown,
  recorded: string,
  input: { readonly workflowKey: string },
) {
  if (typeof declared !== 'string' || !exactSemver.test(declared)) {
    throw failure(
      'invalid_package',
      input,
      `${section}.${packageName} must be an exact semver version.`,
    );
  }
  if (declared !== recorded) {
    throw failure(
      'invalid_package',
      input,
      `${section}.${packageName}@${declared} does not match the recorded ${recorded}.`,
    );
  }
}

async function readSourceInputs(root: string, input: { readonly workflowKey: string }) {
  const entries: HashInput[] = [];
  await visit(root, 'src', entries, input);
  await visit(root, 'tests', entries, input);
  for (const name of ['package.json', 'tsconfig.json']) {
    const path = join(root, name);
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new Error(`${name} is not a regular file.`);
      entries.push({ path: name, bytes: await readFile(path) });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw failure(
          'invalid_package',
          input,
          `Could not read workflow source input ${name}.`,
          cause,
        );
      }
    }
  }
  return entries.filter((entry) => isWorkflowSourcePath(entry.path));
}

async function visit(
  root: string,
  relativeRoot: string,
  entries: HashInput[],
  input: { readonly workflowKey: string },
) {
  const directory = join(root, relativeRoot);
  let children;
  try {
    children = await readdir(directory, { withFileTypes: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw failure('invalid_package', input, `Could not read ${relativeRoot}.`, cause);
  }
  for (const child of children) {
    const relativePath = `${relativeRoot}/${child.name}`;
    const path = containedPath(root, relativePath, input);
    if (child.isSymbolicLink())
      throw failure('invalid_package', input, `Symlinks are unsupported: ${relativePath}.`);
    if (child.isDirectory()) await visit(root, relativePath, entries, input);
    else if (child.isFile()) entries.push({ path: relativePath, bytes: await readFile(path) });
  }
}

async function publishArtifact(
  cacheRoot: string,
  hash: string,
  bytes: Uint8Array,
  input: { readonly workflowKey: string },
) {
  const destination = artifactCachePath(cacheRoot, hash);
  await mkdir(dirname(destination), { recursive: true });
  try {
    await access(destination, constants.F_OK);
    const existing = await readFile(destination);
    if (hashArtifact(existing) !== hash) throw new Error('Existing cache entry is corrupt.');
    return;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw failure(
        'artifact_load_failed',
        input,
        'Could not reuse workflow artifact cache entry.',
        cause,
      );
    }
  }
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, destination);
  } catch (cause) {
    await rm(temporary, { force: true }).catch(() => undefined);
    try {
      const winner = await readFile(destination);
      if (hashArtifact(winner) === hash) return;
    } catch {}
    throw failure(
      'artifact_load_failed',
      input,
      'Could not publish workflow artifact cache entry.',
      cause,
    );
  }
}

async function importCachedArtifact(
  cacheRoot: string,
  hash: string,
  input: {
    readonly workflowKey?: string | undefined;
    readonly artifactHash?: string | undefined;
    readonly structureHash?: string | undefined;
  },
  loadedDefinitions: WorkflowDefinitionCache,
) {
  const cacheKey = `${resolve(cacheRoot)}\0${hash}`;
  let pending = loadedDefinitions.get(cacheKey);
  if (!pending) {
    pending = import(pathToFileURL(artifactCachePath(cacheRoot, hash)).href).then((loaded) =>
      describeWorkflowArtifact(loaded, hash, input),
    );
    loadedDefinitions.set(cacheKey, pending);
  }
  try {
    const artifact = await pending;
    // Checked against the *caller's* expectation rather than the cached one, so a receipt whose
    // structure hash was edited is caught even when the bundle itself is already imported.
    if (input.structureHash && hashDescriptor(artifact.descriptor) !== input.structureHash) {
      throw failure(
        'structure_mismatch',
        input,
        'Workflow structure does not match its build receipt.',
      );
    }
    return artifact;
  } catch (cause) {
    loadedDefinitions.delete(cacheKey);
    if (cause instanceof WorkflowLoadError) throw cause;
    const reason =
      cause instanceof InvalidWorkflowExport ? 'invalid_export' : 'artifact_load_failed';
    throw failure(
      reason,
      input,
      cause instanceof InvalidWorkflowExport
        ? cause.message
        : 'Could not import workflow artifact.',
      cause,
    );
  }
}

/**
 * Turns an imported module namespace into a usable artifact, or refuses.
 *
 * All three structural steps live here rather than at the two call sites, so the pinned path cannot
 * drift into accepting something the publishing path rejects:
 *
 * 1. the module is structurally a workflow, reported per node and edge rather than as one verdict;
 * 2. every graph it declares is reachable as a live object by its key;
 * 3. it contains no node kind this release cannot execute.
 *
 * Step 3 is what keeps `checkpoint()` a real extension seam and an unlaunchable one at the same
 * time: it validates, it gets a descriptor, and it is still refused at load.
 */
export function describeWorkflowArtifact(
  loaded: unknown,
  hash: string,
  input: {
    readonly workflowKey?: string | undefined;
    readonly artifactHash?: string | undefined;
  } = {},
): LoadedWorkflowArtifact {
  const structure = describeWorkflowModule(loaded);
  if (!structure.ok) {
    throw new WorkflowLoadError({
      reason: 'invalid_structure',
      message: `Workflow structure is invalid: ${structure.diagnostics[0]?.message ?? 'no diagnostics reported'}`,
      workflowKey: input.workflowKey,
      artifactHash: hash,
      diagnostics: structure.diagnostics,
    });
  }

  const capabilities = describeCapabilities(structure.descriptor);
  if (!capabilities.launchable) {
    const unsupported = capabilities.unsupported[0];
    throw failure(
      'unsupported_capability',
      { ...input, artifactHash: hash },
      unsupported
        ? `This release cannot execute a ${unsupported.capability} node (${unsupported.graphKey}.${unsupported.nodeId}).`
        : 'This release cannot execute one of this workflow\u2019s node kinds.',
    );
  }

  const definition = (loaded as { default: AnyWorkflowDefinition }).default;
  return {
    artifactHash: hash,
    definition,
    descriptor: structure.descriptor,
    graphs: collectLiveGraphs(definition),
  };
}

/**
 * Maps every declared graph key to the live object that implements it.
 *
 * A plain recursive walk is sound here precisely because it runs *after* `describeWorkflowModule`
 * returned a descriptor: that pass has already rejected cycles, duplicate keys, unbounded depth and
 * malformed identifiers, so there is nothing left for this walk to defend against. A test asserts
 * the keys it produces are exactly the descriptor's, which is what keeps the two from drifting.
 */
function collectLiveGraphs(
  definition: AnyWorkflowDefinition,
): ReadonlyMap<string, AnyGraphDefinition> {
  const graphs = new Map<string, AnyGraphDefinition>();
  const collect = (graph: AnyGraphDefinition) => {
    if (graphs.has(graph.key)) return;
    graphs.set(graph.key, graph);
    for (const node of Object.values(graph.nodes)) {
      if (node.isagiKind === 'subgraph-node') collect(node.graph as AnyGraphDefinition);
    }
  };
  collect(definition.graph as AnyGraphDefinition);
  return graphs;
}

class InvalidWorkflowExport extends Error {}

function artifactCachePath(cacheRoot: string, hash: string) {
  return join(cacheRoot, hash, 'index.mjs');
}
function containedPath(root: string, path: string, input: { readonly workflowKey: string }) {
  const base = resolve(root);
  const candidate = resolve(base, path);
  if (candidate !== base && !candidate.startsWith(`${base}${sep}`))
    throw failure('invalid_package', input, `Path escapes workflow package: ${path}.`);
  return candidate;
}
async function readRegularFile(
  path: string,
  input: { readonly workflowKey?: string | undefined; readonly artifactHash?: string | undefined },
  reason: WorkflowLoadFailureReason,
) {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Path is not a regular file.');
    return await readFile(path);
  } catch (cause) {
    throw failure(reason, input, 'Workflow artifact is unavailable.', cause);
  }
}
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function failure(
  reason: WorkflowLoadFailureReason,
  input: { readonly workflowKey?: string | undefined; readonly artifactHash?: string | undefined },
  message: string,
  cause?: unknown,
) {
  return new WorkflowLoadError({
    reason,
    message,
    workflowKey: input.workflowKey,
    artifactHash: input.artifactHash,
    cause,
  });
}
function normalizeFailure(
  cause: unknown,
  input: { readonly workflowKey?: string | undefined; readonly artifactHash?: string | undefined },
  fallback: WorkflowLoadFailureReason = 'artifact_load_failed',
) {
  return cause instanceof WorkflowLoadError
    ? cause
    : failure(fallback, input, 'Workflow artifact operation failed.', cause);
}
