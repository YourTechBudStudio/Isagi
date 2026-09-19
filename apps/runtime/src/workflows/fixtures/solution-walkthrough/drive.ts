import type { EngineHarness } from '../../engine/test-support.js';
import type { AnyWorkflowDefinition } from '../../structure/loader.js';
import {
  makeSolutionWalkthroughWorkflow,
  type SolutionWalkthroughVariant,
  resetSolutionWalkthroughState,
} from './index.js';

/**
 * What this fixture publishes, one registered version per variant.
 *
 * A variant changes what the definition *does*, so it must not share a pin with another: the
 * artifact hash is what every attempt records and what a Retry adopts.
 */
export function publishSolutionWalkthrough(
  harness: EngineHarness,
  variant: SolutionWalkthroughVariant = {},
) {
  // Every test publishes exactly once before launching, so this is the one place that can clear
  // the previous test's per-run variant state without any test having to remember to.
  resetSolutionWalkthroughState();
  const version = [
    variant.mutateAfterCapture ? 'mutate' : null,
    variant.failAfterCapture ? 'fail' : null,
  ]
    .filter((part): part is string => part !== null)
    .join('-');
  const artifactHash = harness.publish({
    workflowKey: 'solution-walkthrough',
    version: version.length > 0 ? version : 'plain',
    definition: makeSolutionWalkthroughWorkflow(variant) as unknown as AnyWorkflowDefinition,
  });
  harness.setCurrent('solution-walkthrough', version.length > 0 ? version : 'plain');
  return artifactHash;
}
