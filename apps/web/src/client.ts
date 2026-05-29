import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';

import type { contract } from '@isagi/contracts';

export type IsagiClient = ContractRouterClient<typeof contract>;

export function createIsagiClient(runtimeUrl: string): IsagiClient {
  const link = new RPCLink({
    url: new URL('/rpc', runtimeUrl).toString(),
  });

  return createORPCClient(link);
}
