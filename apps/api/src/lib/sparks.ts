import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

interface WriteSparkFileOptions {
  readonly filePath: string;
  readonly sparkId: string;
  readonly title: string;
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

export function createSparkTriageFileName(
  sparkId: string,
  titleSlug: string,
): string {
  return `${sparkId}-${titleSlug}.triage.yaml`;
}

export function getOriginalSparksDir(dataRoot: string): string {
  return path.join(dataRoot, "sparks", "original");
}

export function getWorkingSparksDir(dataRoot: string): string {
  return path.join(dataRoot, "sparks");
}

export function getWorkstreamsDir(dataRoot: string): string {
  return path.join(dataRoot, "workstreams");
}

export function getPromptsDir(dataRoot: string): string {
  return path.join(dataRoot, "prompts");
}

export function resolveWorkingSparkPath(params: {
  dataRoot: string;
  sparkId: string;
  titleSlug: string;
}): string {
  return path.join(
    getWorkingSparksDir(params.dataRoot),
    createSparkFileName(params.sparkId, params.titleSlug),
  );
}

export function resolveOriginalSparkPath(params: {
  dataRoot: string;
  sparkId: string;
  titleSlug: string;
}): string {
  return path.join(
    getOriginalSparksDir(params.dataRoot),
    createSparkFileName(params.sparkId, params.titleSlug),
  );
}

export function resolveSparkTriagePath(params: {
  dataRoot: string;
  sparkId: string;
  titleSlug: string;
}): string {
  return path.join(
    getWorkingSparksDir(params.dataRoot),
    createSparkTriageFileName(params.sparkId, params.titleSlug),
  );
}

function escapeYamlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\"/g, '\\"');
}

export async function ensureDataDirectories(dataRoot: string): Promise<void> {
  await mkdir(dataRoot, { recursive: true });
  await mkdir(getWorkingSparksDir(dataRoot), { recursive: true });
  await mkdir(getOriginalSparksDir(dataRoot), { recursive: true });
  await mkdir(getWorkstreamsDir(dataRoot), { recursive: true });
  await mkdir(getPromptsDir(dataRoot), { recursive: true });
}

export async function writeSparkFile({
  filePath,
  sparkId,
  title,
  text,
  createdAt,
}: WriteSparkFileOptions): Promise<string> {
  await mkdir(path.dirname(filePath), { recursive: true });

  const safeTitle = escapeYamlString(title);
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

export async function writeSparkTriageFile(
  triagePath: string,
): Promise<string> {
  const content = ["version: 1", "items: []", ""].join("\n");
  await mkdir(path.dirname(triagePath), { recursive: true });
  await writeFile(triagePath, content, "utf8");
  return triagePath;
}
