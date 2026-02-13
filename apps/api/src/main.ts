import "./lib/env";

import { RPCHandler } from "@orpc/server/node";
import cors from "cors";
import express from "express";

import { runtimeConfig } from "./lib/config";
import { closeDb } from "./lib/db/client";
import { ensureDatabaseReady } from "./lib/db/init";
import { ensureDataDirectories } from "./lib/sparks";
import { orpcRouter } from "./router";

const app = express();
const handler = new RPCHandler(orpcRouter);

function toHeaders(request: express.Request): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === "string") {
      headers.set(key, value);
    } else if (Array.isArray(value)) {
      headers.set(key, value.join(", "));
    }
  }
  return headers;
}

app.use(cors());
app.use(express.json());

app.use("/api*splat", async (req, res, next) => {
  const { matched } = await handler.handle(req, res, {
    prefix: "/api",
    context: {
      headers: toHeaders(req),
    },
  });

  if (matched) {
    return;
  }

  next();
});

app.get("/", (_req, res) => {
  res.send("Isagi API is online.\n");
});

async function main(): Promise<void> {
  await ensureDataDirectories(runtimeConfig.dataRoot);
  await ensureDatabaseReady();

  const server = app.listen(runtimeConfig.port, () => {
    console.log(`Isagi API listening on port '${runtimeConfig.port}'`);
  });

  const shutdown = async (): Promise<void> => {
    server.close();
    await closeDb();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch(error => {
  console.error("Failed to start Isagi API:", error);
  process.exit(1);
});
