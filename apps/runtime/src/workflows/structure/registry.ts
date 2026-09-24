import { join, normalize } from 'node:path';

import { Context, Data, Effect, Layer } from 'effect';

import { DataDirectory } from '../../persistence/index.js';
import { RuntimeConfig } from '../../runtime-config/index.js';
import {
  dedupeWorkflowSources,
  discoverOrderedWorkflowSources,
  scanWorkflowSource,
  type DiscoveredFilesystemWorkflow,
  type ScanWorkflowSource,
  type WorkflowDiscoverySource,
} from './discovery.js';
import {
  loadPinnedWorkflowArtifact,
  validateAndPublishWorkflowPackage,
  WorkflowLoadError,
  type AnyWorkflowDefinition,
  type WorkflowDefinitionCache,
  type LoadedWorkflowArtifact,
} from './loader.js';

export class WorkflowRegistryError extends Data.TaggedError('WorkflowRegistryError')<{
  readonly code: 'scan_failed' | 'in_memory_mutation_unsupported';
  readonly message: string;
  readonly workflowSourceDirectory?: string | undefined;
  readonly sourceKind?: WorkflowDiscoverySource['kind'] | undefined;
  readonly cause?: unknown;
}> {}

export interface WorkflowPackageProvenance {
  readonly workflowPackageDirectory: string;
  readonly shadowedWorkflowPackageDirectories: readonly string[];
}

const discoveredWorkflowLocator = Symbol('isagi/DiscoveredWorkflowLocator');

type DiscoveredWorkflowLocator =
  | {
      readonly kind: 'filesystem';
      readonly load: () => Effect.Effect<LoadedWorkflowArtifact, WorkflowLoadError>;
    }
  | {
      readonly kind: 'in_memory';
      readonly load: () => Effect.Effect<LoadedWorkflowArtifact, WorkflowLoadError>;
    };

export interface DiscoveredWorkflowEntry {
  readonly workflowKey: string;
  readonly provenance?: WorkflowPackageProvenance | undefined;
  readonly [discoveredWorkflowLocator]: DiscoveredWorkflowLocator;
}

export interface WorkflowDiscoverySnapshot {
  readonly entries: readonly DiscoveredWorkflowEntry[];
  readonly find: (workflowKey: string) => DiscoveredWorkflowEntry | undefined;
}

export interface WorkflowRegistryService {
  readonly discover: (
    context?: WorkflowRegistryContext,
  ) => Effect.Effect<WorkflowDiscoverySnapshot, WorkflowRegistryError>;
  readonly loadDiscovered: (
    entry: DiscoveredWorkflowEntry,
  ) => Effect.Effect<LoadedWorkflowArtifact, WorkflowLoadError>;
  readonly loadPinned: (
    artifactHash: string,
    workflowKey?: string,
  ) => Effect.Effect<LoadedWorkflowArtifact, WorkflowLoadError>;
  readonly addWorkflow: (
    workflowKey: string,
    definition: AnyWorkflowDefinition,
  ) => Effect.Effect<void, WorkflowRegistryError>;
}

export const WorkflowRegistry =
  Context.GenericTag<WorkflowRegistryService>('isagi/WorkflowRegistry');

export const WorkflowRegistryLive = Layer.effect(
  WorkflowRegistry,
  Effect.gen(function* () {
    const directory = yield* DataDirectory;
    const config = yield* RuntimeConfig;
    const startupConfig = yield* config.get;
    return createFilesystemWorkflowRegistry(
      directory.paths.workflowsPath,
      join(directory.paths.root, 'workflow-artifacts'),
      { additionalDirectories: startupConfig.workflows.additionalDirectories },
    );
  }),
);

export interface FilesystemWorkflowRegistryOptions {
  readonly additionalDirectories?: readonly string[] | undefined;
  readonly scanSource?: ScanWorkflowSource | undefined;
}

export function createFilesystemWorkflowRegistry(
  workflowsPath: string,
  cacheRoot: string,
  options: FilesystemWorkflowRegistryOptions = {},
): WorkflowRegistryService {
  const shadowLogKeys = new Set<string>();
  const missingWarningPaths = new Set<string>();
  const definitionCache: WorkflowDefinitionCache = new Map();
  const scanSource = options.scanSource ?? scanWorkflowSource;
  const additionalDirectories = [...(options.additionalDirectories ?? [])];

  return {
    discover: (context) =>
      Effect.try({
        try: () => {
          const discovered = discoverOrderedWorkflowSources(
            workflowDiscoverySources(workflowsPath, additionalDirectories, context),
            (source) => scanSourceWithPolicy(source, scanSource, missingWarningPaths),
          );
          for (const workflow of discovered) logWorkflowShadows(workflow, shadowLogKeys);
          return createDiscoverySnapshot(
            discovered.map((workflow) =>
              filesystemDiscoveryEntry(workflow, cacheRoot, definitionCache),
            ),
          );
        },
        catch: (cause) =>
          cause instanceof WorkflowRegistryError
            ? cause
            : new WorkflowRegistryError({
                code: 'scan_failed',
                message: 'Could not scan workflow sources.',
                cause,
              }),
      }),
    loadDiscovered: (entry) => entry[discoveredWorkflowLocator].load(),
    loadPinned: (artifactHash, workflowKey) =>
      loadPinnedWorkflowArtifact({ artifactHash, cacheRoot, workflowKey, definitionCache }),
    addWorkflow: () =>
      Effect.fail(
        new WorkflowRegistryError({
          code: 'in_memory_mutation_unsupported',
          message: 'Filesystem workflow registry does not support addWorkflow.',
        }),
      ),
  };
}

function scanSourceWithPolicy(
  source: WorkflowDiscoverySource,
  scanSource: ScanWorkflowSource,
  missingWarningPaths: Set<string>,
) {
  try {
    return scanSource(source);
  } catch (cause) {
    if (isErrno(cause, 'ENOENT')) {
      if (source.explicitlyConfigured && !missingWarningPaths.has(source.rootPath)) {
        missingWarningPaths.add(source.rootPath);
        console.warn('[runtime] Configured workflow directory is missing', {
          operation: 'workflow.discover.scan_source',
          workflowSourceDirectory: source.rootPath,
        });
      }
      return [];
    }
    throw new WorkflowRegistryError({
      code: 'scan_failed',
      message: `Could not scan workflow directory: ${source.rootPath}.`,
      workflowSourceDirectory: source.rootPath,
      sourceKind: source.kind,
      cause,
    });
  }
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
  return createDiscoveredWorkflowEntry(
    workflow.workflowKey,
    {
      kind: 'filesystem',
      load: () =>
        validateAndPublishWorkflowPackage({
          workflowKey: workflow.workflowKey,
          packageRoot: workflow.winner.packageRoot,
          cacheRoot,
          definitionCache,
        }),
    },
    provenance,
  );
}

function createDiscoveredWorkflowEntry(
  workflowKey: string,
  locator: DiscoveredWorkflowLocator,
  provenance?: WorkflowPackageProvenance,
): DiscoveredWorkflowEntry {
  return {
    workflowKey,
    ...(provenance ? { provenance } : {}),
    [discoveredWorkflowLocator]: locator,
  };
}

function createDiscoverySnapshot(
  entries: readonly DiscoveredWorkflowEntry[],
): WorkflowDiscoverySnapshot {
  const byKey = new Map(entries.map((entry) => [entry.workflowKey, entry]));
  return { entries, find: (workflowKey) => byKey.get(workflowKey) };
}

function logWorkflowShadows(workflow: DiscoveredFilesystemWorkflow, shadowLogKeys: Set<string>) {
  if (workflow.shadowed.length === 0) return;
  const key = `${workflow.workflowKey}:${workflow.winner.packageRoot}:${workflow.shadowed
    .map((candidate) => candidate.packageRoot)
    .join(':')}`;
  if (shadowLogKeys.has(key)) return;
  shadowLogKeys.add(key);
  console.info('[runtime] Workflow source collision resolved by precedence', {
    workflowKey: workflow.workflowKey,
    winningSourceKind: workflow.winner.source.kind,
    workflowPackageDirectory: workflow.winner.packageRoot,
    shadowedWorkflowPackageDirectories: workflow.shadowed.map((candidate) => candidate.packageRoot),
  });
}

export type WorkflowRegistryServiceError = WorkflowRegistryError | WorkflowLoadError;
