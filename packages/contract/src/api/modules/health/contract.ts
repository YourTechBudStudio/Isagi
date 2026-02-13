import { oc } from "@orpc/contract";
import z from "zod";

const ping = oc.route({ method: "GET", path: "/health" }).output(
  z.object({
    status: z.literal("ok"),
  }),
);

export const healthContract = {
  ping,
};
