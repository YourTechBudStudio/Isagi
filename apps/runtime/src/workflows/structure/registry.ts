import { join, normalize } from 'node:path';

import { Context, Data, Effect, Layer } from 'effect';

import { DataDirectory } from '../../platform/persistence/index.js';
import { RuntimeConfig } from '../../runtime-config/index.js';
import {
  dedupeWorkflowSources,
  discoverOrderedWorkflowSources,
  scanWorkflowSource,
  type DiscoveredFilesystemWorkflow,
  type ScanWorkflowSource,
  type WorkflowDiscoverySource,
  type WorkflowFilesystemCandidate,
} from './discovery.js';
import {
  loadPinnedWorkflowArtifact,
  validateAndPublishWorkflowPackage,
  WorkflowLoadError,
  type LoadedWorkflowArtifact,
  type PublishedWorkflowArtifact,
  type WorkflowDefinitionCache,
} from './loader.js';

export class WorkflowRegistryError extends Data.TaggedError('WorkflowRegistryError')<{
  readonly code: 'scan_failed';
  readonly message: string;
  readonly workflowSourceDirectory?: string | undefined;
  readonly sourceKind?: WorkflowDiscoverySource['kind'] | undefined;
  readonly cause?: unknown;
}> {}

export interface WorkflowPackageProvenance {
  readonly workflowPackageDirectory: string;
  readonly shadowedWorkflowPackageDirectories: readonly string[];
}

export interface DiscoveredWorkflowEntry {
  readonly workflowKey: string;
  readonly provenance?: WorkflowPackageProvenance | undefined;
  /** Verifies the package and publishes its artifact to the content-addressed cache. */
  readonly load: () => Effect.Effect<PublishedWorkflowArtifact, WorkflowLoadError>;
}

export interface WorkflowDiscoverySnapshot {
  readonly entries: readonly DiscoveredWorkflowEntry[];
  readonly find: (workflowKey: string) => DiscoveredWorkflowEntry | undefined;
}

const make = Effect.gen(function* () {
  const directory = yield* DataDirectory;
  const config = yield* RuntimeConfig;
  const startupConfig = yield* config.get;
  return createFilesystemWorkflowRegistry(
    directory.paths.workflowsPath,
    join(directory.paths.root, 'workflow-artifacts'),
    { additionalDirectories: startupConfig.workflows.additionalDirectories },
  );
});

/**
 * Where workflows come from and how their verified builds are loaded.
 *
 * `discover` lists the packages visible from a project, an entry's `load` verifies it and publishes
 * its artifact to the content-addressed cache, and `loadPinned` imports an artifact already in the
 * cache by its hash. Tests supply their own implementation.
 */
export class WorkflowRegistry extends Context.Service<
  WorkflowRegistry,
  {
    readonly discover: (
      context?: WorkflowRegistryContext,
    ) => Effect.Effect<WorkflowDiscoverySnapshot, WorkflowRegistryError>;
    readonly loadPinned: (
      artifactHash: string,
      workflowKey?: string,
    ) => Effect.Effect<LoadedWorkflowArtifact, WorkflowLoadError>;
  }
>()('isagi/runtime/workflows/WorkflowRegistry') {
  static readonly layer = Layer.effect(WorkflowRegistry, make);
}

export interface FilesystemWorkflowRegistryOptions {
  readonly additionalDirectories?: readonly string[] | undefined;
  readonly scanSource?: ScanWorkflowSource | undefined;
}

export function createFilesystemWorkflowRegistry(
  workflowsPath: string,
  cacheRoot: string,
  options: FilesystemWorkflowRegistryOptions = {},
): WorkflowRegistry['Service'] {
  const shadowLogKeys = new Set<string>();
  const missingWarningPaths = new Set<string>();
  const definitionCache: WorkflowDefinitionCache = new Map();
  const scanSource = options.scanSource ?? scanWorkflowSource;
  const additionalDirectories = [...(options.additionalDirectories ?? [])];

  return WorkflowRegistry.of({
    discover: Effect.fn('WorkflowRegistry.discover')(function* (context) {
      const sources = workflowDiscoverySources(workflowsPath, additionalDirectories, context);
      const scanned = new Map<WorkflowDiscoverySource, readonly WorkflowFilesystemCandidate[]>();
      for (const source of sources) {
        scanned.set(source, yield* scanSourceWithPolicy(source, scanSource, missingWarningPaths));
      }
      const discovered = discoverOrderedWorkflowSources(
        sources,
        (source) => scanned.get(source) ?? [],
      );
      for (const workflow of discovered) yield* logWorkflowShadows(workflow, shadowLogKeys);
      return createDiscoverySnapshot(
        discovered.map((workflow) =>
          filesystemDiscoveryEntry(workflow, cacheRoot, definitionCache),
        ),
      );
    }),
    loadPinned: Effect.fn('WorkflowRegistry.loadPinned')(function* (artifactHash, workflowKey) {
      return yield* loadPinnedWorkflowArtifact({
        artifactHash,
        cacheRoot,
        workflowKey,
        definitionCache,
      });
    }),
  });
}

/**
 * Scans one source. A missing source is empty; an explicitly configured one is also warned about,
 * once per path for this registry. Any other filesystem failure fails discovery with the source as
 * context.
 */
function scanSourceWithPolicy(
  source: WorkflowDiscoverySource,
  scanSource: ScanWorkflowSource,
  missingWarningPaths: Set<string>,
): Effect.Effect<readonly WorkflowFilesystemCandidate[], WorkflowRegistryError> {
  return Effect.suspend(() => {
    try {
      return Effect.succeed(scanSource(source));
    } catch (cause) {
      if (!isErrno(cause, 'ENOENT')) {
        return Effect.fail(
          new WorkflowRegistryError({
            code: 'scan_failed',
            message: `Could not scan workflow directory: ${source.rootPath}.`,
            workflowSourceDirectory: source.rootPath,
            sourceKind: source.kind,
            cause,
          }),
        );
      }
      if (!source.explicitlyConfigured || missingWarningPaths.has(source.rootPath)) {
        return Effect.succeed([]);
      }
      missingWarningPaths.add(source.rootPath);
      return Effect.logWarning('Configured workflow directory is missing').pipe(
        Effect.annotateLogs({
          operation: 'workflow.discover.scan_source',
          workflowSourceDirectory: source.rootPath,
        }),
        Effect.as([]),
      );
    }
  });
}

function isErrno(cause: unknown, code: string) {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    (cause as NodeJS.ErrnoException).code === code
  );
}

export interface WorkflowRegistryContext {
  readonly projectId?: number | null | undefined;
  readonly projectRoot?: string | null | undefined;
}

function projectWorkflowsPath(context: WorkflowRegistryContext | undefined) {
  const projectRoot = context?.projectRoot;
  return projectRoot ? join(projectRoot, '.isagi', 'workflows') : null;
}

function workflowDiscoverySources(
  workflowsPath: string,
  additionalDirectories: readonly string[],
  context: WorkflowRegistryContext | undefined,
): readonly WorkflowDiscoverySource[] {
  const sources: WorkflowDiscoverySource[] = [
    { kind: 'core', rootPath: normalize(workflowsPath), explicitlyConfigured: false },
    ...additionalDirectories.map(
      (rootPath, configuredIndex): WorkflowDiscoverySource => ({
        kind: 'additional',
        rootPath: normalize(rootPath),
        configuredIndex,
        explicitlyConfigured: true,
      }),
    ),
  ];
  const projectRoot = projectWorkflowsPath(context);
  if (projectRoot) {
    sources.push({
      kind: 'project',
      projectId: context?.projectId ?? null,
      projectRoot: context?.projectRoot ?? projectRoot,
      rootPath: normalize(projectRoot),
      explicitlyConfigured: false,
    });
  }
  return dedupeWorkflowSources(sources);
}

function filesystemDiscoveryEntry(
  workflow: DiscoveredFilesystemWorkflow,
  cacheRoot: string,
  definitionCache: WorkflowDefinitionCache,
): DiscoveredWorkflowEntry {
  const provenance = {
    workflowPackageDirectory: workflow.winner.packageRoot,
    shadowedWorkflowPackageDirectories: workflow.shadowed.map((candidate) => candidate.packageRoot),
  } satisfies WorkflowPackageProvenance;
  return {
    workflowKey: workflow.workflowKey,
    provenance,
    load: () =>
      validateAndPublishWorkflowPackage({
        workflowKey: workflow.workflowKey,
        packageRoot: workflow.winner.packageRoot,
        cacheRoot,
        definitionCache,
      }),
  };
}

function createDiscoverySnapshot(
  entries: readonly DiscoveredWorkflowEntry[],
): WorkflowDiscoverySnapshot {
  const byKey = new Map(entries.map((entry) => [entry.workflowKey, entry]));
  return { entries, find: (workflowKey) => byKey.get(workflowKey) };
}

function logWorkflowShadows(
  workflow: DiscoveredFilesystemWorkflow,
  shadowLogKeys: Set<string>,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    if (workflow.shadowed.length === 0) return Effect.void;
    const shadowedWorkflowPackageDirectories = workflow.shadowed.map(
      (candidate) => candidate.packageRoot,
    );
    const key = `${workflow.workflowKey}:${workflow.winner.packageRoot}:${shadowedWorkflowPackageDirectories.join(':')}`;
    if (shadowLogKeys.has(key)) return Effect.void;
    shadowLogKeys.add(key);
    return Effect.logInfo('Workflow source collision resolved by precedence').pipe(
      Effect.annotateLogs({
        workflowKey: workflow.workflowKey,
        winningSourceKind: workflow.winner.source.kind,
        workflowPackageDirectory: workflow.winner.packageRoot,
        shadowedWorkflowPackageDirectories,
      }),
    );
  });
}

export type WorkflowRegistryServiceError = WorkflowRegistryError | WorkflowLoadError;
