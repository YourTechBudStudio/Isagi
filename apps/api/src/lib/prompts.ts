import { copyFile, readFile } from "node:fs/promises";
import path from "node:path";

import { getPromptsDir } from "./sparks";

const TRIAGE_PROMPT_FILE = "triage.md";

function getBundledPromptPath(): string {
  return path.resolve(process.cwd(), "prompts", TRIAGE_PROMPT_FILE);
}

export function getPromptPath(dataRoot: string, name: string): string {
  return path.join(getPromptsDir(dataRoot), name);
}

export async function bootstrapPrompts(dataRoot: string): Promise<void> {
  const bundled = getBundledPromptPath();
  const destination = getPromptPath(dataRoot, TRIAGE_PROMPT_FILE);
  await copyFile(bundled, destination);
}

export async function loadPrompt(
  dataRoot: string,
  name: string,
): Promise<string> {
  const promptPath = getPromptPath(dataRoot, name);
  return readFile(promptPath, "utf8");
}

export function renderPrompt(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => {
    return vars[key] ?? "";
  });
}
