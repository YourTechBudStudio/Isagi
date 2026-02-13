import { createContext, useContext } from "react";

import type { ORPC } from "./orpc";

/**
 * React context for the oRPC TanStack Query utils.
 *
 * Provided by the root layout once app config has been loaded.
 * `null` only during the brief splash/boot phase or on the setup screen.
 */
const ORPCContext = createContext<ORPC | null>(null);

export const ORPCProvider = ORPCContext.Provider;

/**
 * Access the oRPC TanStack Query utils.
 *
 * Throws if called outside the provider (i.e. before config is loaded).
 * Components on the setup screen must not call this.
 */
export function useORPC(): ORPC {
  const orpc = useContext(ORPCContext);
  if (!orpc) {
    throw new Error("useORPC called before app config was loaded");
  }
  return orpc;
}
