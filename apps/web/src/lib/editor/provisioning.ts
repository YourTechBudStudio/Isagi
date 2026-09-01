import type { EditorProvisioningState } from '@isagi/contracts';

import { editorProvisioningCopy } from '../../copy/editor.js';

/**
 * The provisioning failure in onboarding's voice: one lowercase line, rendered
 * as a `#` comment beside the harness manifest.
 *
 * Null for every state except a failure — including all four transient ones.
 * Onboarding reports that provisioning *broke*, never that it is *working*: a
 * download the user did not ask for and cannot steer has no business
 * interrupting the screen where they are configuring something else.
 */
export function editorProvisioningManifestLine(state: EditorProvisioningState): string | null {
  return state.status === 'failed' ? editorProvisioningCopy.failure.manifest[state.reason] : null;
}
