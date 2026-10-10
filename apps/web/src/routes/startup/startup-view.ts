import { Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';

import type { ControlPlaneSnapshot } from '@isagi/contracts';

import { deriveStartupGate } from '../../lib/control-plane/launchability.js';
import { mutationError, queryError } from '../../lib/state/result.js';
import { formatRuntimeError } from '../../lib/workspace/runtime-data.js';
import type { BootView } from './StartupSurfaces.js';

/**
 * The boot surface the gate shows for the control-plane read, before onboarding and readiness are
 * considered: `null` means the gate is open (`ready`) or onboarding owns the screen.
 *
 * A pure function of the two atom states the gate reads, so the lifecycle mapping is testable
 * without React: the read is pending → `connecting`; it failed with no snapshot to fall back on →
 * `runtime_unreachable`, `retrying` while a re-read runs; otherwise the snapshot's gate decides.
 */
export function startupBootView(input: {
  readonly controlPlane: AsyncResult.AsyncResult<ControlPlaneSnapshot, unknown>;
  readonly retryProvisioning: AsyncResult.AsyncResult<unknown, unknown>;
  readonly onRetry: () => void;
  readonly onRetryProvisioning: () => void;
}): BootView | null {
  const snapshot = Option.getOrUndefined(AsyncResult.value(input.controlPlane));
  if (!snapshot) {
    return input.controlPlane._tag === 'Initial'
      ? { kind: 'connecting' }
      : {
          kind: 'runtime_unreachable',
          error: formatRuntimeError(queryError(input.controlPlane)),
          retrying: input.controlPlane.waiting,
          onRetry: input.onRetry,
        };
  }
  const gate = deriveStartupGate(snapshot);
  if (gate.kind === 'inventory_pending') return { kind: 'environment_pending' };
  if (gate.kind === 'config_invalid')
    return { kind: 'config_invalid', diagnostic: gate.diagnostic };
  if (gate.kind === 'editor_provisioning') {
    const retryError = mutationError(input.retryProvisioning);
    return {
      kind: 'editor_provisioning',
      state: gate.state,
      retrying: input.retryProvisioning.waiting,
      // The retry request can fail on its own — dropped connection, or a
      // runtime refusal such as `editor_provisioning_busy`. Nothing in
      // the projection records that, so the fn atom carries it back to
      // the button that started it.
      retryError: retryError === null ? null : formatRuntimeError(retryError),
      onRetry: input.onRetryProvisioning,
    };
  }
  return null; // 'ready', or 'onboarding' (the gate handles that branch first).
}
