import { oc } from "@orpc/contract";
import z from "zod";

const health = oc.route({ method: "GET", path: "/health" }).output(
  z.object({
    status: z.literal("ok"),
  }),
);

export const contract = {
  health,
};
