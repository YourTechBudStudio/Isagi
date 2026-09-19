import type { EngineHarness } from '../../engine/test-support.js';
import type { AnyWorkflowDefinition } from '../../structure/loader.js';
import { reviewedDocumentWorkflow } from './index.js';

/**
 * What this fixture publishes.
 *
 * The harness, the world and the pass loop live in `fixtures/drive.ts`, shared with every other
 * fixture. Only the thing that is specific to *this* workflow stays here.
 */
export function publishFixture(harness: EngineHarness, version = '1') {
  return harness.publish({
    workflowKey: 'reviewed-document',
    version,
    definition: reviewedDocumentWorkflow as unknown as AnyWorkflowDefinition,
  });
}
