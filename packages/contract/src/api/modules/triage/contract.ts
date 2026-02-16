import { oc } from "@orpc/contract";
import z from "zod";

const triageItem = z.object({
  id: z.string(),
  kind: z.enum(["container", "work_item", "derived_spark"]),
  status: z.enum(["proposed", "approved", "rejected", "applied"]),
  workstream: z.string(),
  template: z.string().optional(),
  title: z.string().optional(),
  container_ref: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

const list = oc.route({ method: "GET", path: "/triage" }).output(
  z.array(
    z.object({
      sparkId: z.string(),
      sparkTitle: z.string(),
      opencodeSessionId: z.string(),
      statusType: z.enum(["idle", "busy", "retry"]),
      waitingOnUser: z.boolean(),
      closedAt: z.number().nullable(),
      updatedAt: z.number(),
      lastValidationError: z.string().nullable(),
    }),
  ),
);

const state = oc
  .route({ method: "GET", path: "/triage/:sparkId/state" })
  .input(
    z.object({
      sparkId: z.string(),
    }),
  )
  .output(
    z.object({
      sparkId: z.string(),
      opencodeSessionId: z.string(),
      triagePath: z.string(),
      rawYaml: z.string(),
      parsed: z
        .object({
          version: z.literal(1),
          items: z.array(triageItem),
        })
        .nullable(),
      validationError: z.string().nullable(),
    }),
  );

const send = oc
  .route({ method: "POST", path: "/triage/:sparkId/message" })
  .input(
    z.object({
      sparkId: z.string(),
      text: z.string().trim().min(1),
    }),
  )
  .output(
    z.object({
      accepted: z.literal(true),
    }),
  );

const apply = oc
  .route({ method: "POST", path: "/triage/:sparkId/apply" })
  .input(
    z.object({
      sparkId: z.string(),
    }),
  )
  .output(
    z.object({
      sparkId: z.string(),
      status: z.literal("closed"),
      validationError: z.string().nullable(),
    }),
  );

export const triageContract = {
  list,
  state,
  send,
  apply,
};
