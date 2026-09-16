import { readFileSync } from 'node:fs';

import type { WorkflowAgentHarness } from '@yourtechbudstudio/isagi-workflow-sdk';
import { Effect } from 'effect';

import { harnessDefinition } from '../../../agent-sessions/harness/definitions.js';
import type { HarnessAdapterRegistryService } from '../../../agent-sessions/harness/index.js';
import type { HarnessControlPlaneService } from '../../../harness-control-plane/index.js';
import type { PtyServiceShape } from '../../../pty-processes/index.js';
import type { HeadlessOperationAdapter } from './types.js';

export interface HeadlessAdapterDependencies {
  readonly harnesses: HarnessAdapterRegistryService;
  readonly pty: PtyServiceShape;
  readonly controlPlane: HarnessControlPlaneService;
}

/**
 * The real headless adapter.
 *
 * It exposes `allocate` rather than `launch`, because the reservation and the spawn are two
 * separately recordable facts: the operation has to persist process ownership while no process
 * exists, and then record the marker that precedes `start`. `PtyService.launch` is exactly those two
 * steps fused, which is the one shape this recovery model cannot use.
 */
export function makeHeadlessAdapter(
  dependencies: HeadlessAdapterDependencies,
): HeadlessOperationAdapter {
  const asError = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A, Error> =>
    effect.pipe(
      Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))),
    );

  return {
    assertCanCreateProcess: (harness) =>
      asError(dependencies.controlPlane.assertCanCreateProcess(harness)),

    allocate: (input) =>
      asError(
        Effect.gen(function* () {
          const launch = yield* dependencies.harnesses.buildHeadlessLaunch({
            harness: input.harness,
            cwd: input.cwd,
            prompt: input.prompt,
            model: input.model,
            effort: input.effort,
          });
          return yield* dependencies.pty.allocateLaunch(launch);
        }),
      ),

    pin: (ptyProcessId) => dependencies.pty.pin({ ptyProcessId }),
    unpin: (ptyProcessId) => dependencies.pty.unpin({ ptyProcessId }),

    capture: (input) =>
      asError(
        Effect.gen(function* () {
          const plan = yield* dependencies.pty.getAttachmentPlan({
            ptyProcessId: input.ptyProcessId,
          });
          const raw = plan.session.logPath
            ? yield* Effect.try(() => readFileSync(plan.session.logPath ?? '', 'utf8'))
            : '';
          return { raw, output: extractHeadlessOutput(input.harness, raw) };
        }),
      ),

    terminate: (input) => asError(dependencies.pty.terminate(input)),

    semanticError: (input) => semanticErrorForHeadlessOutput(input.harness, input.raw),
  };
}

export function extractHeadlessOutput(harness: WorkflowAgentHarness, raw: string): string {
  return harnessDefinition(harness).launch.extractHeadlessOutput(raw);
}

export function semanticErrorForHeadlessOutput(
  harness: WorkflowAgentHarness,
  raw: string,
): string | null {
  return harnessDefinition(harness).launch.semanticHeadlessError?.(raw) ?? null;
}
