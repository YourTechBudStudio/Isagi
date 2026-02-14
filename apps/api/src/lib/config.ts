import { resolveDatabaseUrl, resolveDataRoot } from "./paths";

interface RuntimeConfig {
  readonly port: number;
  readonly nodeEnv: string;
  readonly dataRoot: string;
  readonly userApiKey: string;
  readonly databaseUrl: string;
}

function parsePort(rawPort: string | undefined): number {
  if (!rawPort) {
    return 13000;
  }

  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("PORT must be a positive integer");
  }

  return port;
}

function resolveUserApiKey(nodeEnv: string): string {
  const fromEnv = process.env.ISAGI_USER_API_KEY?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  if (nodeEnv === "production") {
    throw new Error("ISAGI_USER_API_KEY is required in production");
  }

  const fallback = "dev-isagi";
  console.warn(
    "ISAGI_USER_API_KEY not set; using default dev key 'dev-isagi'.",
  );
  return fallback;
}

const nodeEnv = process.env.NODE_ENV?.trim() || "development";
const dataRoot = resolveDataRoot();
const databaseUrl = resolveDatabaseUrl(dataRoot);

export const runtimeConfig: RuntimeConfig = {
  port: parsePort(process.env.PORT),
  nodeEnv,
  dataRoot,
  userApiKey: resolveUserApiKey(nodeEnv),
  databaseUrl,
};
