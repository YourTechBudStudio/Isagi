import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

interface WriteSparkFileOptions {
  readonly dataRoot: string;
  readonly sparkId: string;
  readonly title: string;
  readonly titleSlug: string;
  readonly text: string;
  readonly createdAt: Date;
}

export function extractSparkTitle(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const title = words.slice(0, 8).join(" ");
  return title.length > 0 ? title : "Untitled spark";
}

export function slugifySparkTitle(title: string): string {
  const cleaned = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join("-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  return cleaned.length > 0 ? cleaned : "untitled-spark";
}

export function createSparkFileName(
  sparkId: string,
  titleSlug: string,
): string {
  return `${sparkId}-${titleSlug}.md`;
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
  titleSlug,
  text,
  createdAt,
}: WriteSparkFileOptions): Promise<string> {
  const sparksDir = path.join(dataRoot, "sparks");
  await mkdir(sparksDir, { recursive: true });

  const safeTitle = escapeYamlString(title);
  const filePath = path.join(
    sparksDir,
    createSparkFileName(sparkId, titleSlug),
  );
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
