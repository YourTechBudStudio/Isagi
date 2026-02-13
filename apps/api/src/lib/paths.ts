import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_DATA_ROOT = path.join(os.homedir(), ".isagi", "data");

function parseRootFromArgs(args: readonly string[]): string | undefined {
  const withEquals = args.find(arg => arg.startsWith("--root="));
  if (withEquals) {
    const value = withEquals.slice("--root=".length).trim();
    return value.length > 0 ? value : undefined;
  }

  const index = args.findIndex(arg => arg === "--root");
  if (index >= 0) {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("--root requires a path value");
    }
    return value.trim();
  }

  return undefined;
}

export function resolveDataRoot(
  args: readonly string[] = process.argv,
): string {
  const cliRoot = parseRootFromArgs(args);
  const envRoot = process.env.ISAGI_ROOT?.trim();
  const resolved = cliRoot || envRoot || DEFAULT_DATA_ROOT;
  return path.resolve(resolved);
}

export function resolveDatabaseUrl(dataRoot: string): string {
  const explicitUrl = process.env.ISAGI_DATABASE_URL?.trim();
  if (explicitUrl) {
    return explicitUrl;
  }

  return pathToFileURL(path.join(dataRoot, "isagi.db")).toString();
}
