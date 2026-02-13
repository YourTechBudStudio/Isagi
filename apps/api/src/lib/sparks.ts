import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

interface WriteSparkFileOptions {
  readonly dataRoot: string;
  readonly sparkId: string;
  readonly title: string;
  readonly text: string;
  readonly createdAt: Date;
}

export function createSparkTitle(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return "Untitled Spark";
  }

  return words.slice(0, 8).join(" ");
}

function escapeYamlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\"/g, '\\"');
}

export async function ensureDataDirectories(dataRoot: string): Promise<void> {
  await mkdir(dataRoot, { recursive: true });
  await mkdir(path.join(dataRoot, "sparks"), { recursive: true });
}

export async function writeSparkFile({
  dataRoot,
  sparkId,
  title,
  text,
  createdAt,
}: WriteSparkFileOptions): Promise<string> {
  const sparksDir = path.join(dataRoot, "sparks");
  await mkdir(sparksDir, { recursive: true });

  const safeTitle = escapeYamlString(title);
  const filePath = path.join(sparksDir, `${sparkId}.md`);
  const content = [
    "---",
    `id: ${sparkId}`,
    `title: \"${safeTitle}\"`,
    `createdAt: \"${createdAt.toISOString()}\"`,
    "---",
    "",
    text.trim(),
    "",
  ].join("\n");

  await writeFile(filePath, content, "utf8");
  return filePath;
}
