import { Context, Effect, Layer } from 'effect';

import type { ConversationMessage } from '../agent-sessions/harness/types.js';
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
    'pi-gate': {
      initialState: { phase: 'spawn' },
      step: async (ctx, state, event) => {
        const current = state as {
          readonly phase: 'spawn' | 'await_turn';
          readonly agentSessionId?: number | undefined;
          readonly harnessSessionId?: string | undefined;
          readonly afterT?: string | undefined;
        };
        if (current.phase === 'spawn') {
          await ctx.setUiFeedback({ phase: 'spawning', message: 'Starting Pi workflow gate.' });
          const seeded = await ctx.spawnSession({
            harness: 'pi',
            prompt: 'Reply with one short sentence confirming the workflow gate is working.',
          });
          await ctx.setUiFeedback({ phase: 'waiting', message: 'Waiting for Pi to reply.' });
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
          throw new Error(`Pi workflow gate turn failed: ${payload.reason}`);
        }
        if (payload?.outcome !== 'ended' || !current.agentSessionId) {
          throw new Error('Pi workflow gate resumed without a completed turn payload.');
        }
        const history = await ctx.getConversationHistory(current.agentSessionId);
        const message = latestAssistantText(history) ?? 'Pi completed the workflow gate.';
        await ctx.setUiFeedback({ phase: 'done', message });
        return done();
      },
    },
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

function latestAssistantText(history: readonly ConversationMessage[]) {
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
