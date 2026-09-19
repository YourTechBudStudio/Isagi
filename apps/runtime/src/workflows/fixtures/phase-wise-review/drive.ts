import type { EngineHarness } from '../../engine/test-support.js';
import type { AnyWorkflowDefinition } from '../../structure/loader.js';
import {
  makePhaseWiseReviewWorkflow,
  type PhaseWiseReviewVariant,
  resetPhaseWiseReviewState,
} from './index.js';

/**
 * What this fixture publishes, one registered version per variant.
 *
 * A variant changes what the definition *does*, so it must not share a pin with another: the
 * artifact hash is what every attempt records and what a Retry adopts, and two behaviours behind
 * one hash would make the record lie about which code ran.
 */
export function publishPhaseWiseReview(
  harness: EngineHarness,
  variant: PhaseWiseReviewVariant = {},
) {
  // Every test publishes exactly once before launching, so this is the one place that can clear
  // the previous test's per-run variant state without any test having to remember to.
  resetPhaseWiseReviewState();
  const version = variant.throwAfterCapture ?? 'plain';
  const artifactHash = harness.publish({
    workflowKey: 'phase-wise-review',
    version,
    definition: makePhaseWiseReviewWorkflow(variant) as unknown as AnyWorkflowDefinition,
  });
  harness.setCurrent('phase-wise-review', version);
  return artifactHash;
}
