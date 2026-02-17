import { useQuery } from "@tanstack/react-query";

import { useORPC } from "@/services/ORPCContext";

/**
 * Fetch the initial message transcript for a triage session.
 *
 * This is used to hydrate the Zustand message store on first load.
 * After hydration, the SSE stream takes over for real-time updates.
 */
export function useTriageMessages(sparkId: string) {
  const orpc = useORPC();

  return useQuery({
    ...orpc.user.triage.messages.queryOptions({ input: { sparkId } }),
    enabled: !!sparkId,
  });
}
