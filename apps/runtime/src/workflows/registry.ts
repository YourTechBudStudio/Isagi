import { join } from 'node:path';

import { cont, done, suspend, wait } from '@yourtechbudstudio/isagi-workflow-sdk';
import { Context, Data, Effect, Layer } from 'effect';

import type { AgentHarness } from '@isagi/contracts';

import { DataDirectory } from '../persistence/index.js';
import {
  discoverOrderedWorkflowSources,
  type DiscoveredFilesystemWorkflow,
  type WorkflowDiscoverySource,
} from './discovery.js';
import {
  loadPinnedWorkflowArtifact,
  validateAndPublishWorkflowPackage,
  WorkflowLoadError,
  type WorkflowDefinitionCache,
  type LoadedWorkflowArtifact,
} from './loader.js';
import type { WorkflowDefinition } from './types.js';

export class WorkflowRegistryError extends Data.TaggedError('WorkflowRegistryError')<{
  readonly code: 'scan_failed' | 'in_memory_mutation_unsupported';
  readonly message: string;
  readonly cause?: unknown;
}> {}

const discoveredWorkflowLocator = Symbol('isagi/DiscoveredWorkflowLocator');

type DiscoveredWorkflowLocator =
  | {
      readonly kind: 'filesystem';
      readonly packageRoot: string;
      readonly shadowedPackageRoots: readonly string[];
      readonly source: WorkflowDiscoverySource;
      readonly shadowedSources: readonly WorkflowDiscoverySource[];
      readonly load: () => Effect.Effect<LoadedWorkflowArtifact, WorkflowLoadError>;
    }
  | {
      readonly kind: 'in_memory';
      readonly definition: WorkflowDefinition<unknown>;
      readonly load: () => Effect.Effect<LoadedWorkflowArtifact, WorkflowLoadError>;
    };

export interface DiscoveredWorkflowEntry {
  readonly workflowKey: string;
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
    definition: WorkflowDefinition<unknown>,
  ) => Effect.Effect<void, WorkflowRegistryError>;
}

export const WorkflowRegistry =
  Context.GenericTag<WorkflowRegistryService>('isagi/WorkflowRegistry');

export const WorkflowRegistryLive = Layer.effect(
  WorkflowRegistry,
  Effect.gen(function* () {
    const directory = yield* DataDirectory;
    return createFilesystemWorkflowRegistry(
      directory.paths.workflowsPath,
      join(directory.paths.root, 'workflow-artifacts'),
    );
  }),
);

export function createFilesystemWorkflowRegistry(
  workflowsPath: string,
  cacheRoot: string,
): WorkflowRegistryService {
  const shadowLogKeys = new Set<string>();
  const definitionCache: WorkflowDefinitionCache = new Map();

  return {
    discover: (context) =>
      Effect.try({
        try: () => {
          const discovered = discoverOrderedWorkflowSources(
            workflowDiscoverySources(workflowsPath, context),
          );
          for (const workflow of discovered) logWorkflowShadows(workflow, shadowLogKeys);
          return createDiscoverySnapshot(
            discovered.map((workflow) =>
              filesystemDiscoveryEntry(workflow, cacheRoot, definitionCache),
            ),
          );
        },
        catch: (cause) =>
          new WorkflowRegistryError({
            code: 'scan_failed',
            message: `Could not scan workflow directory: ${scanFailurePath(cause) ?? 'unknown path'}.`,
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

function scanFailurePath(cause: unknown): string | undefined {
  if (typeof cause !== 'object' || cause === null || !('path' in cause)) return undefined;
  return typeof cause.path === 'string' ? cause.path : undefined;
}

export function createWorkflowRegistry(
  entries: Record<string, WorkflowDefinition<unknown>> = testWorkflows(),
): WorkflowRegistryService {
  const workflows = new Map(Object.entries(entries));
  const hash = '0'.repeat(64);
  return {
    discover: () =>
      Effect.sync(() =>
        createDiscoverySnapshot(
          [...workflows.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([workflowKey, definition]) =>
              createDiscoveredWorkflowEntry(workflowKey, {
                kind: 'in_memory',
                definition,
                load: () => Effect.succeed({ artifactHash: hash, definition }),
              }),
            ),
        ),
      ),
    loadDiscovered: (entry) => entry[discoveredWorkflowLocator].load(),
    loadPinned: (_artifactHash, workflowKey) => {
      const definition = workflowKey ? workflows.get(workflowKey) : undefined;
      return definition
        ? Effect.succeed({ artifactHash: hash, definition })
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

function testWorkflows(): Record<string, WorkflowDefinition<unknown>> {
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
    'agentless-cont-done': {
      command: () => ({ title: 'Agentless cont/done' }),
      validate: () => {},
      init: () => ({ phase: 'a', snapshots: ['a'] }),
      step: async (ctx, state) => {
        const current = state as { readonly phase: string; readonly snapshots: readonly string[] };
        if (current.phase === 'a') {
          return cont({ phase: 'b', snapshots: [...current.snapshots, 'b'] });
        }
        if (current.phase === 'b') {
          await ctx.setUiFeedback({
            phase: 'almost_done',
            message: 'Agentless workflow advanced.',
          });
          return cont({ phase: 'c', snapshots: [...current.snapshots, 'c'] });
        }
        return done();
      },
    },
    'agentless-suspend': {
      command: () => ({ title: 'Agentless suspend' }),
      validate: () => {},
      init: () => ({ phase: 'start' }),
      step: async () =>
        suspend(
          { phase: 'waiting' },
          wait.agentTurn({
            agentSessionId: 10,
            sentAt: '2026-06-18T00:00:00.000Z',
          }),
        ),
    },
    'agentless-throws': {
      command: () => ({ title: 'Agentless throws' }),
      validate: () => {},
      init: () => ({ phase: 'before_throw' }),
      step: async () => {
        throw new Error('Agentless fixture failure.');
      },
    },
  };
}

function agentGateWorkflow(input: {
  readonly harness: AgentHarness;
  readonly label: string;
  readonly prompt: string;
}): WorkflowDefinition<unknown> {
  return {
    command: () => ({ title: `${input.label} gate` }),
    validate: () => {},
    init: () => ({ phase: 'spawn' }),
    step: async (ctx, state, event) => {
      const current = state as {
        readonly phase: 'spawn' | 'await_turn';
        readonly agentSessionId?: number | undefined;
        readonly sentAt?: string | undefined;
      };
      if (current.phase === 'spawn') {
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
        return suspend(
          {
            phase: 'await_turn',
            agentSessionId: seeded.agentSessionId,
            sentAt: seeded.sentAt,
          },
          wait.agentTurn(seeded),
        );
      }

      const payload = event as
        | { readonly outcome: 'ended'; readonly recordedAt: string }
        | { readonly outcome: 'failed'; readonly recordedAt: string; readonly reason: string }
        | undefined;
      if (payload?.outcome === 'failed') {
        throw new Error(`${input.label} workflow gate turn failed: ${payload.reason}`);
      }
      if (payload?.outcome !== 'ended' || !current.agentSessionId) {
        throw new Error(`${input.label} workflow gate resumed without a completed turn payload.`);
      }
      const history = await ctx.getConversationHistory(current.agentSessionId);
      const message = latestAssistantText(history) ?? `${input.label} completed the workflow gate.`;
      await ctx.setUiFeedback({ phase: 'done', message });
      return done();
    },
  };
}

function latestAssistantText(history: readonly import('./types.js').WorkflowConversationMessage[]) {
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
  context: WorkflowRegistryContext | undefined,
): readonly WorkflowDiscoverySource[] {
  const sources: WorkflowDiscoverySource[] = [{ kind: 'global', rootPath: workflowsPath }];
  const projectRoot = projectWorkflowsPath(context);
  if (projectRoot) {
    sources.push({
      kind: 'project',
      projectId: context?.projectId ?? null,
      projectRoot: context?.projectRoot ?? projectRoot,
      rootPath: projectRoot,
    });
  }
  return sources;
}

function filesystemDiscoveryEntry(
  workflow: DiscoveredFilesystemWorkflow,
  cacheRoot: string,
  definitionCache: WorkflowDefinitionCache,
): DiscoveredWorkflowEntry {
  return createDiscoveredWorkflowEntry(workflow.workflowKey, {
    kind: 'filesystem',
    packageRoot: workflow.winner.packageRoot,
    shadowedPackageRoots: workflow.shadowed.map((candidate) => candidate.packageRoot),
    source: workflow.winner.source,
    shadowedSources: workflow.shadowed.map((candidate) => candidate.source),
    load: () =>
      validateAndPublishWorkflowPackage({
        workflowKey: workflow.workflowKey,
        packageRoot: workflow.winner.packageRoot,
        cacheRoot,
        definitionCache,
      }),
  });
}

function createDiscoveredWorkflowEntry(
  workflowKey: string,
  locator: DiscoveredWorkflowLocator,
): DiscoveredWorkflowEntry {
  return { workflowKey, [discoveredWorkflowLocator]: locator };
}

function createDiscoverySnapshot(
  entries: readonly DiscoveredWorkflowEntry[],
): WorkflowDiscoverySnapshot {
  const byKey = new Map(entries.map((entry) => [entry.workflowKey, entry]));
  return { entries, find: (workflowKey) => byKey.get(workflowKey) };
}

function logWorkflowShadows(workflow: DiscoveredFilesystemWorkflow, shadowLogKeys: Set<string>) {
  if (workflow.shadowed.length === 0 || workflow.winner.source.kind !== 'project') return;
  const projectSource = workflow.winner.source;
  const key = `${projectSource.projectId ?? 'unknown'}:${projectSource.projectRoot}:${workflow.workflowKey}`;
  if (shadowLogKeys.has(key)) return;
  shadowLogKeys.add(key);
  console.info('[runtime] Project workflow shadows global workflow', {
    workflowKey: workflow.workflowKey,
    projectId: projectSource.projectId,
    projectWorkflowsPath: projectSource.rootPath,
    globalWorkflowsPath: workflow.shadowed[0]?.source.rootPath,
  });
}

export type WorkflowRegistryServiceError = WorkflowRegistryError | WorkflowLoadError;
