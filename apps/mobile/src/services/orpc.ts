import { contract } from "@isagi/contract/api";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";

import type { AppConfig } from "./appConfig";

type Client = ContractRouterClient<typeof contract>;

/**
 * Create an oRPC client and TanStack Query utils bound to the given config.
 *
 * Called once after config is loaded from SecureStore. The returned `orpc`
 * object provides `.queryOptions()` / `.mutationOptions()` helpers that
 * plug straight into TanStack Query hooks.
 */
export function createORPC(config: AppConfig): {
  client: Client;
  orpc: ReturnType<typeof createTanstackQueryUtils<Client>>;
} {
  const link = new RPCLink({
    url: config.apiUrl,
    headers: () => ({
      authorization: `Bearer ${config.userApiKey}`,
    }),
  });

  const client: Client = createORPCClient(link);
  const orpc = createTanstackQueryUtils(client, { path: ["isagi"] });

  return { client, orpc };
}

/**
 * Convenience type so consumers can reference the utils shape without
 * importing half the oRPC generics.
 */
export type ORPC = ReturnType<typeof createORPC>["orpc"];
