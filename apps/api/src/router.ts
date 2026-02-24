import { contract } from "@isagi/contract/api";
import { implement, ORPCError } from "@orpc/server";

const os = implement(contract);

export const router = os.router({
  health: os.health.handler(async () => {
    try {
      return { status: "ok" };
    } catch (error) {
      if (error instanceof ORPCError) {
        throw error;
      }

      console.error("Health check failed:", error);
      throw new ORPCError("INTERNAL_SERVER_ERROR");
    }
  }),
});
