import { useAtomValue } from '@effect/atom-react';
import { Duration, Effect, Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';

import type {
  AcceptHarnessPolicyInput,
  AgentHarness,
  ControlPlaneSnapshot,
} from '@isagi/contracts';

import { keys } from '../state/keys.js';
import { pollWhile, query, revalidate } from '../state/policy.js';
import {
  acceptHarnessPolicy as requestAcceptHarnessPolicy,
  fetchControlPlane,
} from '../workspace/runtime-data.js';
import {
  deriveStartupGate,
  editorAvailable,
  isTransientProvisioning,
  launchableHarnesses,
} from './launchability.js';

/**
 * The control-plane snapshot as cached: the default freshness policy, refreshed by
 * `keys.controlPlane`. Read-after-write paths (`refreshAndRead`, `revalidate`) target this; every
 * component reads {@link controlPlaneAtom}, which adds the gate's polling on top of the same data.
 */
export const controlPlaneQuery = query(() => fetchControlPlane(), { keys: [keys.controlPlane] });

/**
 * How long until the gate polls again, or `null` for no polling.
 *
 * Poll only while the host inventory is still probing, or while editor provisioning is still
 * working. Every other gate state is settled and changes only through an explicit refresh, a policy
 * save, or a provisioning retry, all of which refresh this query themselves.
 *
 * A *failed* provisioning deliberately does not poll: retrying is the user's to start, and the
 * retry refreshes this query when it settles. This is the only pre-workspace freshness mechanism
 * there is — runtime events cannot help, because that subscription mounts inside `WorkspacePage`.
 *
 * The decision reads the last snapshot the query holds, also under a failed refetch, as the old
 * `refetchInterval` read `query.state.data`.
 */
export function controlPlanePollInterval(
  result: AsyncResult.AsyncResult<ControlPlaneSnapshot, unknown>,
): Duration.Duration | null {
  return Option.match(AsyncResult.value(result), {
    onNone: () => null,
    onSome: (snapshot) => {
      const gate = deriveStartupGate(snapshot);
      return gate.kind === 'inventory_pending' ||
        (gate.kind === 'editor_provisioning' && isTransientProvisioning(gate.state))
        ? Duration.seconds(1)
        : null;
    },
  });
}

/** What every component reads: the control-plane snapshot, polled while the gate is unsettled. */
export const controlPlaneAtom = pollWhile(controlPlaneQuery, controlPlanePollInterval);

/** The snapshot the app currently holds, if any (also under a failed refetch). */
function useControlPlaneSnapshot(): ControlPlaneSnapshot | undefined {
  return Option.getOrUndefined(AsyncResult.value(useAtomValue(controlPlaneAtom)));
}

// The set of harnesses the runtime would launch right now, for palette selectors.
// Reads the cached snapshot the gate already loaded; empty until it is present.
export function useLaunchableHarnesses(): readonly AgentHarness[] {
  const snapshot = useControlPlaneSnapshot();
  return snapshot ? launchableHarnesses(snapshot) : [];
}

/**
 * Whether the runtime would open an editor right now. Reads the cached snapshot
 * the gate already loaded; false until it is present, which is the honest
 * reading of "no facts yet".
 */
export function useEditorAvailable(): boolean {
  const snapshot = useControlPlaneSnapshot();
  return snapshot ? editorAvailable(snapshot) : false;
}

/**
 * Commit a harness policy, then re-read the control plane before answering, so the caller sees the
 * gate the commit produced (the old mutation awaited its invalidation in `onSuccess`). A failed
 * re-read does not fail the commit; the policy is saved either way.
 */
export const acceptHarnessPolicy = Effect.fn('acceptHarnessPolicy')(function* (
  input: AcceptHarnessPolicyInput,
) {
  const output = yield* requestAcceptHarnessPolicy(input);
  yield* revalidate(controlPlaneQuery);
  return output;
});
