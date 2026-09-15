import { join, normalize } from 'node:path';

import {
  complete,
  createGraph,
  defineWorkflow,
  edge,
  operation,
  outcome,
  reduce,
  suspend,
  wait,
} from '@yourtechbudstudio/isagi-workflow-sdk';
import { Context, Data, Effect, Layer } from 'effect';

import type { AgentHarness } from '@isagi/contracts';

import { DataDirectory } from '../../persistence/index.js';
import { RuntimeConfig } from '../../runtime-config/index.js';
import type { WorkflowConversationMessage, WorkflowInputs } from '../types.js';
import {
  dedupeWorkflowSources,
  discoverOrderedWorkflowSources,
  scanWorkflowSource,
  type DiscoveredFilesystemWorkflow,
  type ScanWorkflowSource,
  type WorkflowDiscoverySource,
} from './discovery.js';
import {
  describeWorkflowArtifact,
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

export function createWorkflowRegistry(
  entries: Record<string, AnyWorkflowDefinition> = testWorkflows(),
): WorkflowRegistryService {
  const workflows = new Map(Object.entries(entries));
  const hash = '0'.repeat(64);
  // Described through the real extractor rather than hand-assembled: an in-memory workflow that
  // would fail structural validation must fail here too, or these tests would be checking a shape
  // the loader never accepts.
  const artifactOf = (definition: AnyWorkflowDefinition) =>
    describeWorkflowArtifact({ default: definition }, hash);
  return {
    discover: () =>
      Effect.sync(() =>
        createDiscoverySnapshot(
          [...workflows.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([workflowKey, definition]) =>
              createDiscoveredWorkflowEntry(workflowKey, {
                kind: 'in_memory',
                load: () => Effect.succeed(artifactOf(definition)),
              }),
            ),
        ),
      ),
    loadDiscovered: (entry) => entry[discoveredWorkflowLocator].load(),
    loadPinned: (_artifactHash, workflowKey) => {
      const definition = workflowKey ? workflows.get(workflowKey) : undefined;
      return definition
        ? Effect.succeed(artifactOf(definition))
        : Effect.fail(
            new WorkflowLoadError({
              reason: 'pinned_artifact_unavailable',
              message: 'Pinned test workflow was not found.',
              workflowKey,
              artifactHash: _artifactHash,
            }),
          );
    },
    addWorkflow: (workflowKey, definition) =>
      Effect.sync(() => {
        workflows.set(workflowKey, definition);
      }),
  };
}

/**
 * In-memory workflows for tests and manual harness gates.
 *
 * Test-only and undiscoverable: nothing in `discover()` can reach them from the filesystem, and they
 * exist so engine and harness tests have real graph definitions to run without building a package.
 * They are authored against the same public SDK an author uses, so they cannot drift into a private
 * shape the real contract does not support.
 */
function testWorkflows(): Record<string, AnyWorkflowDefinition> {
  return {
    'pi-gate': agentGateWorkflow({
      harness: 'pi',
      label: 'Pi',
      prompt: 'Reply with one short sentence confirming the workflow gate is working.',
    }),
    'codex-gate': agentGateWorkflow({
      harness: 'codex',
      label: 'Codex',
      prompt: 'Reply with one short sentence confirming the workflow gate is working.',
    }),
    'agentless-cont-done': agentlessWorkflow(),
    'agentless-suspend': agentlessSuspendWorkflow(),
    'agentless-throws': agentlessThrowingWorkflow(),
  } as Record<string, AnyWorkflowDefinition>;
}

/** Two visits to one node, so a test can observe a reducer applying twice and a loop edge. */
function agentlessWorkflow() {
  const graph = createGraph<
    { readonly phase: string; readonly snapshots: readonly string[] },
    { readonly snapshots: string },
    WorkflowInputs
  >({
    key: 'agentless-cont-done',
    title: 'Agentless cont/done',
    init: () => ({ phase: 'a', snapshots: ['a'] }),
    state: { phase: reduce.replace<string>(), snapshots: reduce.append<string>() },
    entry: 'advance',
    nodes: {
      advance: operation(async (ctx, state) => {
        if (state.phase === 'b') {
          await ctx.setUiFeedback({
            phase: 'almost_done',
            message: 'Agentless workflow advanced.',
          });
        }
        return complete({
          update: { phase: nextPhase(state.phase), snapshots: nextPhase(state.phase) },
        });
      }),
    },
    edges: {
      'advance-out': edge({
        from: 'advance',
        to: ['advance', 'finished'],
        choose: (state) => ({ to: state.phase === 'c' ? 'finished' : 'advance' }),
      }),
    },
    outcomes: {
      finished: outcome({ kind: 'success', output: (state) => ({ snapshots: state.snapshots }) }),
    },
  });
  return defineWorkflow({
    command: () => ({ title: 'Agentless cont/done' }),
    validate: () => {},
    graph,
  });
}

function nextPhase(phase: string): string {
  return phase === 'a' ? 'b' : phase === 'b' ? 'c' : 'c';
}

/** Suspends on a human gate, so a test can drive wait arming, delivery and consumption. */
function agentlessSuspendWorkflow() {
  const graph = createGraph<{ readonly acknowledged: boolean }, {}, WorkflowInputs>({
    key: 'agentless-suspend',
    title: 'Agentless suspend',
    init: () => ({ acknowledged: false }),
    state: { acknowledged: reduce.replace<boolean>() },
    entry: 'askForAck',
    nodes: {
      askForAck: operation(async () => complete({ update: { acknowledged: false } })),
      recordAck: operation(async () => complete({ update: { acknowledged: true } })),
    },
    edges: {
      'ask-out': edge({
        from: 'askForAck',
        to: ['recordAck'],
        choose: () => ({ to: 'recordAck' }),
      }),
      'record-out': edge({
        from: 'recordAck',
        to: ['acknowledged'],
        choose: () => ({ to: 'acknowledged' }),
      }),
    },
    outcomes: {
      acknowledged: outcome({
        kind: 'success',
        output: (state) => ({ acknowledged: state.acknowledged }),
      }),
    },
  });
  return defineWorkflow({
    command: () => ({ title: 'Agentless suspend' }),
    validate: () => {},
    graph,
  });
}

/** A callback that throws, so a test can observe a real execution-segment failure. */
function agentlessThrowingWorkflow() {
  const graph = createGraph<{ readonly attempted: boolean }, {}, WorkflowInputs>({
    key: 'agentless-throws',
    title: 'Agentless throws',
    init: () => ({ attempted: false }),
    state: { attempted: reduce.replace<boolean>() },
    entry: 'boom',
    nodes: {
      boom: operation(async () => {
        throw new Error('Agentless workflow failed on purpose.');
      }),
    },
    edges: {
      'boom-out': edge({ from: 'boom', to: ['never'], choose: () => ({ to: 'never' }) }),
    },
    outcomes: {
      never: outcome({ kind: 'success', output: (state) => ({ attempted: state.attempted }) }),
    },
  });
  return defineWorkflow({
    command: () => ({ title: 'Agentless throws' }),
    validate: () => {},
    graph,
  });
}

/**
 * The manual harness gate: spawn a session, suspend on its turn, then read the reply back.
 *
 * `getConversationHistory` is a scoped read rather than a journaled operation, so a repaired segment
 * reads again and may legitimately see a different answer.
 */
function agentGateWorkflow(input: {
  readonly harness: AgentHarness;
  readonly label: string;
  readonly prompt: string;
}) {
  const graph = createGraph<
    { readonly agentSessionId: number | null; readonly message: string | null },
    {},
    WorkflowInputs
  >({
    key: `${input.harness}-gate`,
    title: `${input.label} gate`,
    init: () => ({ agentSessionId: null, message: null }),
    state: {
      agentSessionId: reduce.replace<number | null>(),
      message: reduce.replace<string | null>(),
    },
    entry: 'askAgent',
    nodes: {
      askAgent: operation(async (ctx) => {
        await ctx.setUiFeedback({
          phase: 'spawning',
          message: `Starting ${input.label} workflow gate.`,
        });
        const seeded = await ctx.spawnAgentSession({
          harness: input.harness,
          prompt: input.prompt,
        });
        await ctx.setUiFeedback({
          phase: 'waiting',
          message: `Waiting for ${input.label} to reply.`,
        });
        return suspend({
          update: { agentSessionId: seeded.agentSessionId },
          wait: wait.agentTurn(seeded),
        });
      }),
      readReply: operation(async (ctx, state) => {
        const history =
          state.agentSessionId === null
            ? []
            : await ctx.getConversationHistory(state.agentSessionId);
        const message =
          latestAssistantText(history) ?? `${input.label} completed the workflow gate.`;
        await ctx.setUiFeedback({ phase: 'done', message });
        return complete({ update: { message } });
      }),
    },
    edges: {
      'ask-out': edge({
        from: 'askAgent',
        to: ['readReply', 'turnFailed'],
        // A confirmed failed turn is *data* the author routes on, not an execution failure.
        choose: (_state, event) =>
          event.kind === 'agent_turn' && event.outcome === 'failed'
            ? { to: 'turnFailed' }
            : { to: 'readReply' },
      }),
      'read-out': edge({ from: 'readReply', to: ['replied'], choose: () => ({ to: 'replied' }) }),
    },
    outcomes: {
      replied: outcome({ kind: 'success', output: (state) => ({ message: state.message }) }),
      turnFailed: outcome({
        kind: 'failure',
        reason: 'agent_turn_failed',
        output: (state) => ({ message: state.message }),
      }),
    },
  });
  return defineWorkflow({
    command: () => ({ title: `${input.label} gate` }),
    validate: () => {},
    graph,
  });
}

function latestAssistantText(history: readonly WorkflowConversationMessage[]) {
  for (const message of [...history].reverse()) {
    if (message.role !== 'assistant') continue;
    const text = message.parts
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
      .trim();
    if (text.length > 0) return text;
  }
  return null;
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
