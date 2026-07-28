import { queryOptions, useQuery } from '@tanstack/react-query';
import type { Effect } from 'effect';

import type { ClientSettingsOutput } from '@isagi/contracts';

import { runRuntimeEffect } from '../runtime/run.js';
import { fetchClientSettings } from '../workspace/runtime-data.js';

export const clientSettingsQueryKey = ['client-settings'] as const;

export function clientSettingsQueryOptions(
  fetchSettings: () => Effect.Effect<ClientSettingsOutput, Error> = fetchClientSettings,
) {
  return queryOptions({
    queryKey: clientSettingsQueryKey,
    queryFn: ({ signal }) => runRuntimeEffect(fetchSettings(), { signal }),
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

export function useClientSettingsQuery() {
  return useQuery(clientSettingsQueryOptions());
}
