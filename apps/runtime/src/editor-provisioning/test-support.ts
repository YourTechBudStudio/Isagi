import { Effect, Layer } from 'effect';

import type { EditorProvisioningState } from '@isagi/contracts';

import {
  EditorProvisioning,
  EditorUnavailable,
  type EditorProvisioningService,
} from './editor-provisioning.service.js';

/**
 * A provisioning service pinned to one state, for consumers that compose the
 * projection but do not exercise provisioning itself.
 *
 * Every method other than `state` dies rather than returning a plausible value:
 * a test that reaches one of them has left the behaviour it meant to assert.
 */
export function editorProvisioningStateLayer(state: EditorProvisioningState) {
  return Layer.succeed(EditorProvisioning, {
    start: Effect.void,
    state: Effect.succeed(state),
    retry: Effect.die('retry is not used by this test'),
    requireReady: Effect.fail(
      new EditorUnavailable({ reason: 'editor_unavailable', diagnostic: null }),
    ),
  } satisfies EditorProvisioningService);
}

/** The default for a runtime that declares no editor capability. */
export const NotApplicableEditorProvisioningLayer = editorProvisioningStateLayer({
  status: 'not_applicable',
});
