import { readFile, writeFile } from "node:fs/promises";

import YAML from "yaml";
import { z } from "zod";

const triageItemSchema = z.object({
  id: z.string().trim().min(1),
  kind: z.enum(["container", "work_item", "derived_spark"]),
  status: z.enum(["proposed", "approved", "rejected", "applied"]),
  workstream: z.string().trim().min(1),
  template: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).optional(),
  container_ref: z.string().trim().min(1).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const triageDocumentSchema = z.object({
  version: z.literal(1),
  items: z.array(triageItemSchema),
});

export type TriageDocument = z.infer<typeof triageDocumentSchema>;
export type TriageItem = z.infer<typeof triageItemSchema>;

export const TRIAGE_ITEM_SCHEMA_JSON = {
  type: "object",
  additionalProperties: false,
  required: ["id", "kind", "status", "workstream"],
  properties: {
    id: { type: "string", minLength: 1 },
    kind: {
      type: "string",
      enum: ["container", "work_item", "derived_spark"],
    },
    status: {
      type: "string",
      enum: ["proposed", "approved", "rejected", "applied"],
    },
    workstream: { type: "string", minLength: 1 },
    template: { type: "string", minLength: 1 },
    title: { type: "string", minLength: 1 },
    container_ref: { type: "string", minLength: 1 },
    data: { type: "object", additionalProperties: true },
  },
} as const;

export const TRIAGE_DOCUMENT_SCHEMA_JSON = {
  type: "object",
  additionalProperties: false,
  required: ["version", "items"],
  properties: {
    version: { const: 1 },
    items: {
      type: "array",
      items: TRIAGE_ITEM_SCHEMA_JSON,
    },
  },
} as const;

export interface TriageValidationResult {
  readonly raw: string;
  readonly parsed: TriageDocument | null;
  readonly error: string | null;
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map(issue => {
      const field = issue.path.length > 0 ? issue.path.join(".") : "root";
      return `${field}: ${issue.message}`;
    })
    .join("; ");
}

export async function readAndValidateTriageFile(
  triagePath: string,
): Promise<TriageValidationResult> {
  const raw = await readFile(triagePath, "utf8");

  try {
    const parsedYaml = YAML.parse(raw);
    const parsed = triageDocumentSchema.parse(parsedYaml);
    return { raw, parsed, error: null };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        raw,
        parsed: null,
        error: formatZodError(error),
      };
    }

    return {
      raw,
      parsed: null,
      error: error instanceof Error ? error.message : "Invalid triage yaml",
    };
  }
}

export async function writeTriageFile(
  triagePath: string,
  document: TriageDocument,
): Promise<void> {
  const yaml = YAML.stringify(document);
  await writeFile(triagePath, yaml, "utf8");
}

export async function applyAndCloseTriageFile(
  triagePath: string,
): Promise<TriageValidationResult> {
  const current = await readAndValidateTriageFile(triagePath);
  if (!current.parsed) {
    return current;
  }

  const next: TriageDocument = {
    version: current.parsed.version,
    items: current.parsed.items.map(item => {
      if (item.status === "approved") {
        return { ...item, status: "applied" };
      }

      if (item.status === "proposed") {
        return { ...item, status: "rejected" };
      }

      return item;
    }),
  };

  await writeTriageFile(triagePath, next);
  return {
    raw: YAML.stringify(next),
    parsed: next,
    error: null,
  };
}
