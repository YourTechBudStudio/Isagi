import { mkdir, rm, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  checkpoint,
  complete,
  createGraph,
  defineWorkflow,
  edge,
  operation,
  outcome,
  reduce,
  subgraph,
  type CheckpointPlan,
} from '@yourtechbudstudio/isagi-workflow-sdk';

/**
 * Phase-wise work with a checkpoint after each phase, authored against the public SDK.
 *
 * `write` produces a phase directory and appends to a shared decisions file; `save` checkpoints
 * that phase's directory and the decisions file; the loop runs twice; then a nested `finalize`
 * graph seals everything under `scratch` with one more checkpoint. That is three checkpoints on
 * three distinct executions — two visits of one root node and one in a nested frame — which is
 * what makes run-linear parentage observable rather than asserted.
 *
 * Phase 2 deletes phase 1's draft, and the nested seal recaptures `scratch` as a whole, so the last
 * checkpoint's inventory has to say the draft is gone even though the phase-1 checkpoint saved it.
 *
 * Hermetic: `write` touches only the run's destination directory, which the test makes a Git
 * repository.
 */

export const phaseLimit = 2;

interface PhaseState {
  readonly phase: number;
}

export interface PhaseCheckpointsVariant {
  /** Replaces `save`'s `prepare`, for the failure and plan-shape cases. */
  readonly savePrepare?: (state: PhaseState) => unknown;
  /** Registers `save` as an operation instead: the changed-node pin a Retry must refuse. */
  readonly saveAsOperation?: boolean;
}

export const phasePrepare = (state: PhaseState): CheckpointPlan => ({
  title: `Phase ${state.phase} saved`,
  capture: [
    { scope: `phase-${state.phase}`, directory: `scratch/phase-${state.phase}` },
    { scope: 'decisions', file: 'decisions.md' },
  ],
});

const SealGraph = createGraph<{ readonly sealed: boolean }, {}, {}, null>({
  key: 'finalize',
  title: 'Finalize',
  init: () => ({ sealed: false }),
  state: { sealed: reduce.replace<boolean>() },
  entry: 'seal',
  nodes: {
    seal: checkpoint({
      title: 'Seal',
      description: 'Everything under scratch, as the run leaves it.',
      prepare: () => ({ capture: [{ scope: 'all', directory: 'scratch' }] }),
    }),
  },
  edges: { 'seal-out': edge({ from: 'seal', to: ['sealed'], choose: () => ({ to: 'sealed' }) }) },
  outcomes: { sealed: outcome({ kind: 'success', output: () => null }) },
});

export function makePhaseCheckpointsWorkflow(variant: PhaseCheckpointsVariant = {}) {
  const save = variant.saveAsOperation
    ? operation<PhaseState, {}>(async () => complete({}), { title: 'Save the phase' })
    : checkpoint<PhaseState>({
        title: 'Save the phase',
        prepare:
          (variant.savePrepare as ((state: PhaseState) => CheckpointPlan) | undefined) ??
          phasePrepare,
      });

  const root = createGraph<PhaseState, {}, Record<string, unknown>, number>({
    key: 'phases',
    title: 'Phases',
    init: () => ({ phase: 0 }),
    state: { phase: reduce.replace<number>() },
    entry: 'write',
    nodes: {
      write: operation(
        async (ctx, state) => {
          const phase = state.phase + 1;
          const directory = join(ctx.worktreePath, 'scratch', `phase-${phase}`);
          await mkdir(directory, { recursive: true });
          await writeFile(join(directory, 'plan.md'), `# Phase ${phase}\n`);
          if (phase === 1) await writeFile(join(directory, 'draft.md'), 'rough notes\n');
          else {
            await rm(join(ctx.worktreePath, 'scratch', `phase-${phase - 1}`, 'draft.md'), {
              force: true,
            });
          }
          await appendFile(join(ctx.worktreePath, 'decisions.md'), `- phase ${phase}\n`);
          return complete({ update: { phase } });
        },
        { title: 'Write the phase' },
      ),
      save,
      finalize: subgraph({
        graph: SealGraph,
        title: 'Finalize',
        parameters: () => ({}),
        onResult: () => ({}),
      }),
    },
    edges: {
      'write-out': edge({ from: 'write', to: ['save'], choose: () => ({ to: 'save' }) }),
      'save-out': edge({
        from: 'save',
        to: ['write', 'finalize'],
        choose: (state) => (state.phase < phaseLimit ? { to: 'write' } : { to: 'finalize' }),
      }),
      'finalize-out': edge({ from: 'finalize', to: ['done'], choose: () => ({ to: 'done' }) }),
    },
    outcomes: { done: outcome({ kind: 'success', output: (state) => state.phase }) },
  });

  return defineWorkflow({
    command: () => ({ title: 'Phase checkpoints' }),
    validate: () => {},
    graph: root,
  });
}
