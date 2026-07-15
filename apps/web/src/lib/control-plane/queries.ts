import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { AcceptHarnessPolicyInput, AgentHarness } from '@isagi/contracts';

import { runRuntimeEffect } from '../runtime/run.js';
import {
  acceptHarnessPolicy,
  fetchControlPlane,
  refreshInventory,
} from '../workspace/runtime-data.js';
import { deriveStartupGate, launchableHarnesses } from './launchability.js';

export const controlPlaneQueryKey = ['control-plane'] as const;

export function useControlPlaneQuery({ enabled = true }: { readonly enabled?: boolean } = {}) {
  return useQuery({
    enabled,
    queryKey: controlPlaneQueryKey,
    queryFn: ({ signal }) => runRuntimeEffect(fetchControlPlane(), { signal }),
    // Poll only while the host inventory is still probing at startup; every other
    // gate state is settled and changes only through an explicit refresh or a
    // policy save, both of which invalidate this query themselves.
    refetchInterval: (query) =>
      query.state.data && deriveStartupGate(query.state.data).kind === 'inventory_pending'
        ? 1000
        : false,
  });
}

// The set of harnesses the runtime would launch right now, for palette selectors.
// Reads the cached snapshot the gate already loaded; empty until it is present.
export function useLaunchableHarnesses(): readonly AgentHarness[] {
  const query = useControlPlaneQuery();
  return query.data ? launchableHarnesses(query.data) : [];
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
