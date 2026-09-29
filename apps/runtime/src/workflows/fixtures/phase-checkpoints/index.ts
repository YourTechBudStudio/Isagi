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
 * three distinct executions: two visits of one root node and one in a nested graph invocation.
 *
 * Phase 2 deletes phase 1's draft, and the nested seal copies `scratch` as a whole, so the last
 * checkpoint has no draft even though the phase-1 checkpoint saved it. Checkpoints do not stack:
 * each one is a complete copy of the scopes it names.
 *
 * Hermetic: `write` touches only the run's destination directory, which the test makes a Git
 * repository.
 */

export const phaseLimit = 2;

interface PhaseState {
  readonly phase: number;
}

export interface PhaseCheckpointsVariant {
  /** Replaces `save`'s `plan`, for the failure and plan-shape cases. */
  readonly savePlan?: (state: PhaseState) => unknown;
  /** Replaces `save`'s `label`; `null` declares none. */
  readonly saveLabel?: ((state: PhaseState) => string) | null;
  /** Registers `save` as an operation instead: a changed node kind a Retry must refuse. */
  readonly saveAsOperation?: boolean;
}

export const phasePlan = (state: PhaseState): CheckpointPlan => ({
  capture: [
    { scope: `phase-${state.phase}`, directory: `scratch/phase-${state.phase}` },
    { scope: 'decisions', file: 'decisions.md' },
  ],
});

export const phaseLabel = (state: PhaseState): string => `Phase ${state.phase} saved`;

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
      plan: () => ({ capture: [{ scope: 'all', directory: 'scratch' }] }),
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
        label: variant.saveLabel === null ? undefined : (variant.saveLabel ?? phaseLabel),
        plan:
          (variant.savePlan as ((state: PhaseState) => CheckpointPlan) | undefined) ?? phasePlan,
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
          const directory = join(ctx.destination.worktreePath, 'scratch', `phase-${phase}`);
          await mkdir(directory, { recursive: true });
          await writeFile(join(directory, 'plan.md'), `# Phase ${phase}\n`);
          if (phase === 1) await writeFile(join(directory, 'draft.md'), 'rough notes\n');
          else {
            await rm(
              join(ctx.destination.worktreePath, 'scratch', `phase-${phase - 1}`, 'draft.md'),
              {
                force: true,
              },
            );
          }
          await appendFile(
            join(ctx.destination.worktreePath, 'decisions.md'),
            `- phase ${phase}\n`,
          );
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
    parse: () => ({}),
    graph: root,
  });
}
