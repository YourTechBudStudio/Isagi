import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { Context, Data, Effect, Layer } from 'effect';

import type { AgentHarness } from '@isagi/contracts';
import { cont, done, suspend } from '@isagi/workflow-sdk';

import { DataDirectory } from '../persistence/index.js';
import { loadWorkflowDefinition, type WorkflowLoadError } from './loader.js';
import { ensureWorkflowsScaffold, type WorkflowScaffoldError } from './scaffold.js';
import type { WorkflowDefinition } from './types.js';

export class WorkflowRegistryError extends Data.TaggedError('WorkflowRegistryError')<{
  readonly code: 'scan_failed' | 'in_memory_mutation_unsupported';
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface WorkflowRegistryService {
  readonly get: (
    workflowKey: string,
  ) => Effect.Effect<WorkflowDefinition<unknown> | null, WorkflowRegistryError | WorkflowLoadError>;
  readonly knownKeys: Effect.Effect<readonly string[], WorkflowRegistryError>;
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
    yield* ensureWorkflowsScaffold({ workflowsPath: directory.paths.workflowsPath });
    return createFilesystemWorkflowRegistry(directory.paths.workflowsPath);
  }),
);

export function createFilesystemWorkflowRegistry(workflowsPath: string): WorkflowRegistryService {
  const loadedDefinitions = new Map<
    string,
    {
      readonly sourceHash: string;
      readonly definition: WorkflowDefinition<unknown>;
    }
  >();

  return {
    get: (workflowKey) =>
      Effect.gen(function* () {
        const keys = yield* knownWorkflowKeys(workflowsPath);
        if (!keys.includes(workflowKey)) return null;
        const sourceHash = yield* workflowDefinitionHash(workflowsPath, workflowKey);
        const cached = loadedDefinitions.get(workflowKey);
        if (cached?.sourceHash === sourceHash) return cached.definition;
        const definition = yield* loadWorkflowDefinition({
          workflowKey,
          indexPath: workflowIndexPath(workflowsPath, workflowKey),
          artifactPath: workflowArtifactPath(workflowsPath, workflowKey, sourceHash),
        });
        loadedDefinitions.set(workflowKey, { sourceHash, definition });
        return definition;
      }),
    knownKeys: knownWorkflowKeys(workflowsPath),
    addWorkflow: () =>
      Effect.fail(
        new WorkflowRegistryError({
          code: 'in_memory_mutation_unsupported',
          message: 'Filesystem workflow registry does not support addWorkflow.',
        }),
      ),
  };
}

export function createWorkflowRegistry(
  entries: Record<string, WorkflowDefinition<unknown>> = testWorkflows(),
): WorkflowRegistryService {
  const workflows = new Map(Object.entries(entries));
  return {
    get: (workflowKey) => Effect.succeed(workflows.get(workflowKey) ?? null),
    knownKeys: Effect.sync(() => [...workflows.keys()].sort()),
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
          {
            kind: 'turn',
            agentSessionId: 10,
            harnessSessionId: 'phase-1-fixture',
            afterT: '2026-06-18T00:00:00.000Z',
          },
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
        readonly harnessSessionId?: string | undefined;
        readonly afterT?: string | undefined;
      };
      if (current.phase === 'spawn') {
        await ctx.setUiFeedback({
          phase: 'spawning',
          message: `Starting ${input.label} workflow gate.`,
        });
        const seeded = await ctx.spawnSession({
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
            harnessSessionId: seeded.harnessSessionId,
            afterT: seeded.seededAt,
          },
          {
            kind: 'turn',
            agentSessionId: seeded.agentSessionId,
            harnessSessionId: seeded.harnessSessionId,
            afterT: seeded.seededAt,
          },
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

function knownWorkflowKeys(workflowsPath: string) {
  return Effect.try({
    try: () =>
      readdirSync(workflowsPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => !name.startsWith('.') && name !== 'node_modules')
        .filter((name) => existsSync(workflowIndexPath(workflowsPath, name)))
        .sort(),
    catch: (cause) =>
      new WorkflowRegistryError({
        code: 'scan_failed',
        message: `Could not scan workflows directory ${workflowsPath}.`,
        cause,
      }),
  });
}

function workflowIndexPath(workflowsPath: string, workflowKey: string) {
  return join(workflowsPath, workflowKey, 'index.ts');
}

function workflowDefinitionHash(workflowsPath: string, workflowKey: string) {
  return Effect.try({
    try: () => {
      const workflowPath = join(workflowsPath, workflowKey);
      const hash = createHash('sha256');
      hash.update('isagi-workflow-loader-esbuild-v1\0');
      for (const path of listWorkflowSourceFiles(workflowPath)) {
        hash.update(relative(workflowPath, path));
        hash.update('\0');
        hash.update(readFileSync(path));
        hash.update('\0');
      }
      return hash.digest('hex');
    },
    catch: (cause) =>
      new WorkflowRegistryError({
        code: 'scan_failed',
        message: `Could not fingerprint workflow ${workflowKey}.`,
        cause,
      }),
  });
}

function workflowArtifactPath(workflowsPath: string, workflowKey: string, sourceHash: string) {
  return join(
    workflowsPath,
    '.cache',
    'workflow-definitions',
    workflowKey,
    sourceHash,
    'index.mjs',
  );
}

function listWorkflowSourceFiles(root: string): readonly string[] {
  const files: string[] = [];
  visitWorkflowSourceDirectory(root, files);
  return files.sort();
}

function visitWorkflowSourceDirectory(path: string, files: string[]) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      visitWorkflowSourceDirectory(child, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(child);
    }
  }
}

export type WorkflowRegistryServiceError =
  | WorkflowRegistryError
  | WorkflowLoadError
  | WorkflowScaffoldError;
