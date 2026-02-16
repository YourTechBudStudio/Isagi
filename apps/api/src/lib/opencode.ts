import { spawn } from "node:child_process";
import net from "node:net";

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

import { runtimeConfig } from "./config";
import {
  getOpencodeInstanceByRootPath,
  touchOpencodeInstance,
  upsertOpencodeInstance,
} from "./db/opencode.repository";

interface SpawnResult {
  readonly baseUrl: string;
  readonly pid: number;
  readonly port: number;
}

interface ManagedInstance {
  readonly id: string;
  readonly rootPath: string;
  readonly baseUrl: string;
  readonly port: number;
  readonly pid: number;
}

const START_PORT = 4096;
const MAX_PORT_SCAN = 200;

function isPortFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function allocatePort(): Promise<number> {
  for (let offset = 0; offset < MAX_PORT_SCAN; offset += 1) {
    const port = START_PORT + offset;
    if (await isPortFree(port)) {
      return port;
    }
  }

  throw new Error("Unable to find free OpenCode port");
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

async function waitForHealth(
  baseUrl: string,
  rootPath: string,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const client = createOpencodeClient({ baseUrl, directory: rootPath });
      await client.global.health();
      return;
    } catch {
      await sleep(200);
    }
  }

  throw new Error(`OpenCode server did not pass healthcheck at ${baseUrl}`);
}

async function spawnOpenCodeServer(rootPath: string): Promise<SpawnResult> {
  const port = await allocatePort();
  const args = [
    "serve",
    "--hostname=127.0.0.1",
    `--port=${port}`,
    `--directory=${rootPath}`,
  ];
  const proc = spawn("opencode", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  const pid = proc.pid;
  if (!pid) {
    throw new Error("Failed to spawn opencode process");
  }

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, rootPath);
  return { baseUrl, pid, port };
}

async function isHealthy(baseUrl: string, rootPath: string): Promise<boolean> {
  try {
    const client = createOpencodeClient({ baseUrl, directory: rootPath });
    await client.global.health();
    return true;
  } catch {
    return false;
  }
}

function killPid(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // noop
  }
}

export async function ensureOpencodeInstance(
  rootPath: string,
): Promise<ManagedInstance> {
  const now = new Date();
  const existing = await getOpencodeInstanceByRootPath(rootPath);

  if (!existing) {
    const spawned = await spawnOpenCodeServer(rootPath);
    const row = await upsertOpencodeInstance({
      rootPath,
      baseUrl: spawned.baseUrl,
      pid: spawned.pid,
      port: spawned.port,
      seenAt: now,
    });

    return {
      id: row.id,
      rootPath: row.rootPath,
      baseUrl: row.baseUrl,
      port: row.port,
      pid: row.pid,
    };
  }

  if (await isHealthy(existing.baseUrl, rootPath)) {
    await touchOpencodeInstance(existing.id, now);
    return {
      id: existing.id,
      rootPath: existing.rootPath,
      baseUrl: existing.baseUrl,
      port: existing.port,
      pid: existing.pid,
    };
  }

  killPid(existing.pid);
  const spawned = await spawnOpenCodeServer(rootPath);
  const row = await upsertOpencodeInstance({
    rootPath,
    baseUrl: spawned.baseUrl,
    pid: spawned.pid,
    port: spawned.port,
    seenAt: now,
  });

  return {
    id: row.id,
    rootPath: row.rootPath,
    baseUrl: row.baseUrl,
    port: row.port,
    pid: row.pid,
  };
}

export function getOpencodeClient(input: {
  baseUrl: string;
  rootPath: string;
}) {
  return createOpencodeClient({
    baseUrl: input.baseUrl,
    directory: input.rootPath,
  });
}

export function getDefaultOpencodeRootPath(): string {
  return runtimeConfig.dataRoot;
}
