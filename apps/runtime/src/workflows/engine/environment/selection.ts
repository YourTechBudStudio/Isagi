import { Effect, Schema } from 'effect';

import { workflowPlacementRequestSchema, type WorkflowPlacementRequestDto } from '@isagi/contracts';

import { errorMessage } from '../../state/pure.js';
import type { AnyWorkflowDefinition } from '../../structure/loader.js';
import { WorkflowEngineError, type WorkflowOrigin } from '../../types.js';
import { makeEnvironmentContext, type DiscoveryDeps } from './discovery.js';
import type { LaunchProject, PlacementSelection } from './types.js';

const decodePlacementRequest = Schema.decodeUnknown(workflowPlacementRequestSchema);

/** The unchanged behaviour of every workflow that says nothing about where it runs. */
const defaultRequest: WorkflowPlacementRequestDto = {
  worktree: { kind: 'current' },
  surface: { kind: 'current' },
};

export interface SelectionInput {
  readonly definition: AnyWorkflowDefinition;
  readonly workflowKey: string;
  readonly origin: WorkflowOrigin;
  readonly project: LaunchProject;
  readonly inputs: Record<string, unknown>;
  readonly placement: WorkflowPlacementRequestDto | undefined;
}

/**
 * Which of the three sources decides this launch's placement.
 *
 * The precedence is deliberate: a caller-supplied `placement` wins, then the author's `environment`
 * hook, then the current/current default. The caller is a person or a CLI saying "put this here",
 * and an override that the workflow could quietly overrule would not be an override.
 *
 * Both non-default sources are decoded through the contract schema before they leave. That is what
 * keeps a malformed placement a *launch rejection* the person sees immediately, rather than a
 * failure deep inside preparation with a run row and a claimed attempt already behind it.
 */
export function selectPlacement(
  deps: DiscoveryDeps,
  input: SelectionInput,
): Effect.Effect<PlacementSelection, WorkflowEngineError> {
  if (input.placement !== undefined) {
    // Already decoded at the API boundary. Re-decoding is cheap and keeps in-process callers — the
    // controls, tests, a future CLI — held to the same shape the wire holds a client to. The hook
    // is not called at all: an override is a decision, not a suggestion.
    return decodePlacementRequest(input.placement).pipe(
      Effect.map((request): PlacementSelection => ({ source: 'override', request })),
      Effect.mapError(
        (cause) =>
          new WorkflowEngineError({
            code: 'workflow_placement_invalid',
            message: `The requested placement is not a valid placement: ${errorMessage(cause)}`,
            workflowKey: input.workflowKey,
          }),
      ),
    );
  }

  const hook = input.definition.environment;
  if (typeof hook !== 'function') {
    return Effect.succeed({ source: 'default', request: defaultRequest });
  }

  return Effect.gen(function* () {
    const { context, close } = makeEnvironmentContext(deps, {
      origin: input.origin,
      project: input.project,
    });
    const raw = yield* Effect.tryPromise({
      try: async () => hook(context, input.inputs),
      catch: selectionFailed(input.workflowKey),
    }).pipe(Effect.ensuring(Effect.sync(close)));

    const request = yield* decodePlacementRequest(raw).pipe(
      Effect.mapError(selectionFailed(input.workflowKey)),
    );
    return { source: 'selector', request } satisfies PlacementSelection;
  });
}

/**
 * A hook that threw and a hook that returned nonsense are the same failure to the person launching.
 *
 * Both mean "this workflow could not say where it should run", and neither is distinguishable from
 * the other in any way the person could act on differently — the message carries the difference.
 */
function selectionFailed(workflowKey: string) {
  return (cause: unknown) =>
    new WorkflowEngineError({
      code: 'workflow_environment_selection_failed',
      message: errorMessage(cause),
      workflowKey,
    });
}
