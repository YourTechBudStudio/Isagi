import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { AcceptHarnessPolicyInput, AgentHarness } from '@isagi/contracts';

import { runRuntimeEffect } from '../runtime/run.js';
import {
  acceptHarnessPolicy,
  fetchControlPlane,
  refreshInventory,
} from '../workspace/runtime-data.js';
import {
  deriveStartupGate,
  editorAvailable,
  isTransientProvisioning,
  launchableHarnesses,
} from './launchability.js';

export const controlPlaneQueryKey = ['control-plane'] as const;

export function useControlPlaneQuery({ enabled = true }: { readonly enabled?: boolean } = {}) {
  return useQuery({
    enabled,
    queryKey: controlPlaneQueryKey,
    queryFn: ({ signal }) => runRuntimeEffect(fetchControlPlane(), { signal }),
    // Poll only while the host inventory is still probing, or while editor
    // provisioning is still working. Every other gate state is settled and
    // changes only through an explicit refresh, a policy save, or a provisioning
    // retry, all of which invalidate this query themselves.
    //
    // A *failed* provisioning deliberately does not poll: retrying is the user's
    // to start, and the retry mutation invalidates this query on settle. This is
    // the only pre-workspace freshness mechanism there is — runtime events
    // cannot help, because that subscription mounts inside `WorkspacePage`.
    refetchInterval: (query) => {
      const gate = query.state.data ? deriveStartupGate(query.state.data) : null;
      if (gate?.kind === 'inventory_pending') return 1000;
      return gate?.kind === 'editor_provisioning' && isTransientProvisioning(gate.state)
        ? 1000
        : false;
    },
  });
}

// The set of harnesses the runtime would launch right now, for palette selectors.
// Reads the cached snapshot the gate already loaded; empty until it is present.
export function useLaunchableHarnesses(): readonly AgentHarness[] {
  const query = useControlPlaneQuery();
  return query.data ? launchableHarnesses(query.data) : [];
}

/**
 * Whether the runtime would open an editor right now. Reads the cached snapshot
 * the gate already loaded; false until it is present, which is the honest
 * reading of "no facts yet".
 */
export function useEditorAvailable(): boolean {
  const query = useControlPlaneQuery();
  return query.data ? editorAvailable(query.data) : false;
}

export function useRefreshInventoryMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => runRuntimeEffect(refreshInventory()),
    onSuccess: () => client.invalidateQueries({ queryKey: controlPlaneQueryKey }),
  });
}

export function useAcceptHarnessPolicyMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: AcceptHarnessPolicyInput) => runRuntimeEffect(acceptHarnessPolicy(input)),
    onSuccess: () => client.invalidateQueries({ queryKey: controlPlaneQueryKey }),
  });
}
