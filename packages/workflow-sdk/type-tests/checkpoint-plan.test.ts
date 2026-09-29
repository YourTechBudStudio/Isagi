/**
 * A checkpoint's `plan` and `label` are typed against the graph's own state, and the plan is checked
 * at the registration site. Every `@ts-expect-error` here is paired with a positive case that must
 * still compile, so a lost check fails the build as an unused directive.
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

// Positive: state is typed in both callbacks, optional fields accept explicit `undefined`, and both
// scope kinds are accepted.
graphWith(
  checkpoint<PhaseState>({
    title: 'Phase saved',
    label: (state) => `Phase ${state.phase}`,
    plan: (state) => ({
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

// Positive: the label is optional.
graphWith(checkpoint<PhaseState>({ plan: () => ({ capture: [] }) }));

const plan: CheckpointPlan = { capture: [] };
void plan;

// @ts-expect-error a plan names only what to capture; the display name is the node's label.
const planWithTitle: CheckpointPlan = { title: 'Phase 1', capture: [] };
void planWithTitle;

checkpoint<PhaseState>({
  // @ts-expect-error `plan` is synchronous; a promise is not a plan.
  plan: async () => ({ capture: [] }),
});

checkpoint<PhaseState>({
  // @ts-expect-error a scope names either a directory or a file, and needs a stable id.
  plan: () => ({ capture: [{ directory: 'scratch' }] }),
});

checkpoint<PhaseState>({
  plan: () => ({ capture: [] }),
  // @ts-expect-error `phase` is a number on this graph's state.
  label: (state) => state.phase.toUpperCase(),
});

checkpoint<PhaseState>({
  plan: () => ({ capture: [] }),
  // @ts-expect-error a label is a display name, so it returns a string.
  label: (state) => state.phase,
});

// @ts-expect-error `plan` is required.
checkpoint<PhaseState>({ title: 'Review the diff' });
