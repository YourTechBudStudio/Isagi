import { contract } from "@isagi/contract/api";
import { implement, ORPCError } from "@orpc/server";

import { runtimeConfig } from "./lib/config";
import { router as healthRouter } from "./modules/health/router";
import { router as sparksRouter } from "./modules/sparks/router";
import { router as triageRouter } from "./modules/triage/router";

const root = implement(contract).$context<{ headers: Headers }>();
const userOs = implement(contract.user).$context<{ headers: Headers }>();

const requireUserApiKey = userOs.middleware(async ({ context, next }) => {
  const authorization = context.headers.get("authorization");
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;

  if (!token || token !== runtimeConfig.userApiKey) {
    throw new ORPCError("UNAUTHORIZED", {
      message: "Invalid user API key",
    });
  }

  return next({
    context: {
      actor: {
        kind: "user",
        userId: "user",
      },
    },
  });
});

const userRouter = userOs.use(requireUserApiKey).router({
  health: healthRouter,
  sparks: sparksRouter,
  triage: triageRouter,
});

export const orpcRouter = root.router({
  user: userRouter,
});
