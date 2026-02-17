import { useQuery } from "@tanstack/react-query";

import { useORPC } from "@/services/ORPCContext";

/**
 * Fetch triage state (parsed YAML + validation) for a specific spark.
 *
 * Used by the plan tab to display proposed/approved/rejected items.
 */
export function useTriageState(sparkId: string) {
  const orpc = useORPC();

  return useQuery({
    ...orpc.user.triage.state.queryOptions({ input: { sparkId } }),
    enabled: !!sparkId,
  });
}
