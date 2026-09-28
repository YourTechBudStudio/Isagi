/**
 * A checkpoint's `prepare` is typed against the graph's own state, and its plan is checked at the
 * registration site. Every `@ts-expect-error` here is paired with a positive case that must still
 * compile, so a lost check fails the build as an unused directive.
 */
import { checkpoint, createGraph, edge, outcome, reduce } from '../src/index.js';
import type { CheckpointPlan } from '../src/index.js';

interface PhaseState {
  readonly phase: number;
  readonly title: string;
}

const graphWith = (save: ReturnType<typeof checkpoint<PhaseState>>) =>
  createGraph<PhaseState, {}, { readonly phase: number }, string>({
    key: 'Phases',
    title: 'Phases',
    init: (_destination, parameters) => ({ phase: parameters.phase, title: '' }),
    state: { phase: reduce.replace<number>(), title: reduce.replace<string>() },
    entry: 'save',
    nodes: { save },
    edges: { fromSave: edge({ from: 'save', to: ['done'], choose: () => ({ to: 'done' }) }) },
    outcomes: { done: outcome({ kind: 'success', output: (state) => String(state.phase) }) },
  });

// Positive: state is typed, optional plan fields accept explicit `undefined`, and both scope kinds.
graphWith(
  checkpoint<PhaseState>({
    title: 'Phase saved',
    prepare: (state) => ({
      title: state.title || undefined,
      capture: [
        {
          scope: `phase-${state.phase}`,
          directory: `scratch/phase-${state.phase}`,
          exclude: undefined,
        },
        { scope: 'decisions', file: 'decisions.md' },
      ],
    }),
  }),
);

const plan: CheckpointPlan = { capture: [] };
void plan;

checkpoint<PhaseState>({
  // @ts-expect-error `prepare` is synchronous; a promise is not a plan.
  prepare: async () => ({ capture: [] }),
});

checkpoint<PhaseState>({
  // @ts-expect-error a scope names either a directory or a file, and needs a stable id.
  prepare: () => ({ capture: [{ directory: 'scratch' }] }),
});

checkpoint<PhaseState>({
  // @ts-expect-error `phase` is a number on this graph's state.
  prepare: (state) => ({ capture: [], title: state.phase.toUpperCase() }),
});

// @ts-expect-error a checkpoint has no static caption any more; `prepare` is required.
checkpoint<PhaseState>({ caption: 'Review the diff' });
