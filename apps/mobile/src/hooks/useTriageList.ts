import { useQuery } from "@tanstack/react-query";

import { useORPC } from "@/services/ORPCContext";

/**
 * Fetch the triage inbox list via `user.triage.list`.
 *
 * Auto-refreshes on a 30-second interval while the component is mounted.
 */
export function useTriageList() {
  const orpc = useORPC();

  return useQuery({
    ...orpc.user.triage.list.queryOptions({ input: undefined }),
    refetchInterval: 30_000,
  });
}
