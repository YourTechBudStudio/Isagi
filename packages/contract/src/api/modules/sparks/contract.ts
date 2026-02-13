import { oc } from "@orpc/contract";
import z from "zod";

const capture = oc
  .route({ method: "POST", path: "/sparks/capture" })
  .input(
    z.object({
      text: z.string().trim().min(1),
    }),
  )
  .output(
    z.object({
      sparkId: z.string(),
      title: z.string(),
    }),
  );

export const sparksContract = {
  capture,
};
