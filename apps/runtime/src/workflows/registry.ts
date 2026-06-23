import { Context, Effect, Layer } from 'effect';

import { cont, done, suspend } from './constructors.js';
import type { WorkflowDefinition } from './types.js';

export interface WorkflowRegistryService {
  readonly get: (workflowKey: string) => WorkflowDefinition | undefined;
  readonly knownKeys: () => readonly string[];
  readonly addWorkflow: (
    workflowKey: string,
    definition: WorkflowDefinition,
  ) => Effect.Effect<void>;
}

export const WorkflowRegistry =
  Context.GenericTag<WorkflowRegistryService>('isagi/WorkflowRegistry');

export const WorkflowRegistryLive = Layer.effect(
  WorkflowRegistry,
  Effect.sync(() => createWorkflowRegistry(builtInWorkflows())),
);

export function createWorkflowRegistry(
  entries: Record<string, WorkflowDefinition> = {},
): WorkflowRegistryService {
  const workflows = new Map(Object.entries(entries));
  return {
    get: (workflowKey) => workflows.get(workflowKey),
    knownKeys: () => [...workflows.keys()].sort(),
    addWorkflow: (workflowKey, definition) =>
      Effect.sync(() => {
        workflows.set(workflowKey, definition);
      }),
  };
}

function builtInWorkflows(): Record<string, WorkflowDefinition> {
  return {
    'agentless-cont-done': {
      initialState: { phase: 'a', snapshots: ['a'] },
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
      initialState: { phase: 'start' },
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
      initialState: { phase: 'before_throw' },
      step: async () => {
        throw new Error('Agentless fixture failure.');
      },
    },
  };
}
