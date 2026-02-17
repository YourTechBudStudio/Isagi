import { ORPCError } from "@orpc/server";

import {
  createOpencodeSession,
  createSparkTriage,
  findOpencodeSessionByExternalId,
  getSparkTriageBySessionId,
  setOpencodeSessionLastMessageRole,
  setOpencodeSessionStatus,
  setSparkTriageValidationError,
} from "./db/opencode.repository";
import { getSparkById } from "./db/sparks.repository";
import {
  ensureOpencodeInstance,
  getDefaultOpencodeRootPath,
  getOpencodeClient,
} from "./opencode";
import { loadPrompt, renderPrompt } from "./prompts";
import {
  readAndValidateTriageFile,
  TRIAGE_DOCUMENT_SCHEMA_JSON,
} from "./triage";

function statusToType(status: unknown): "idle" | "busy" | "retry" | undefined {
  if (!status || typeof status !== "object") {
    return undefined;
  }

  const value = Reflect.get(status, "type");
  if (value === "idle" || value === "busy" || value === "retry") {
    return value;
  }

  return undefined;
}

async function sendValidationFixPrompt(input: {
  baseUrl: string;
  rootPath: string;
  sessionId: string;
  triagePath: string;
  error: string;
}): Promise<void> {
  const client = getOpencodeClient({
    baseUrl: input.baseUrl,
    rootPath: input.rootPath,
  });

  await client.session.promptAsync({
    sessionID: input.sessionId,
    parts: [
      {
        type: "text",
        text: [
          "Schema validation error detected in triage yaml.",
          `Path: ${input.triagePath}`,
          `Error: ${input.error}`,
          "Please update only the triage yaml to satisfy the schema.",
        ].join("\n"),
      },
    ],
  });
}

// TODO: replace this with LSP-backed schema validation feedback.
async function validateTriageAfterIdle(input: {
  sessionId: string;
  baseUrl: string;
  rootPath: string;
}): Promise<void> {
  const triage = await getSparkTriageBySessionId(input.sessionId);
  if (!triage || triage.closedAt) {
    return;
  }

  const validation = await readAndValidateTriageFile(triage.triagePath);
  if (!validation.error) {
    await setSparkTriageValidationError({
      sparkId: triage.sparkId,
      error: null,
      updatedAt: new Date(),
    });
    return;
  }

  await setSparkTriageValidationError({
    sparkId: triage.sparkId,
    error: validation.error,
    updatedAt: new Date(),
  });

  await sendValidationFixPrompt({
    baseUrl: input.baseUrl,
    rootPath: input.rootPath,
    sessionId: input.sessionId,
    triagePath: triage.triagePath,
    error: validation.error,
  });
}

function getMessageRole(payload: unknown): "user" | "assistant" | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const info = Reflect.get(payload, "info");
  if (!info || typeof info !== "object") {
    return undefined;
  }

  const role = Reflect.get(info, "role");
  if (role === "user" || role === "assistant") {
    return role;
  }

  return undefined;
}

function getMessageSessionId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const info = Reflect.get(payload, "info");
  if (!info || typeof info !== "object") {
    return undefined;
  }

  const sessionID = Reflect.get(info, "sessionID");
  return typeof sessionID === "string" ? sessionID : undefined;
}

export async function startSparkTriage(sparkId: string): Promise<void> {
  const spark = await getSparkById(sparkId);
  if (!spark) {
    throw new ORPCError("NOT_FOUND", {
      message: `Spark not found: ${sparkId}`,
    });
  }

  if (!spark.originalPath || !spark.workingPath || !spark.triagePath) {
    throw new ORPCError("BAD_REQUEST", {
      message: `Spark ${sparkId} does not have triage file paths`,
    });
  }

  const rootPath = getDefaultOpencodeRootPath();
  const instance = await ensureOpencodeInstance(rootPath);
  const client = getOpencodeClient({
    baseUrl: instance.baseUrl,
    rootPath,
  });
  const now = new Date();

  const created = await client.session.create({
    title: `Triage: ${spark.title}`,
  });

  const opencodeSessionId =
    created.data?.id ??
    (typeof Reflect.get(created, "id") === "string"
      ? (Reflect.get(created, "id") as string)
      : undefined);
  if (!opencodeSessionId) {
    throw new Error(
      `OpenCode session.create returned no session id: ${JSON.stringify(created)}`,
    );
  }
  await createOpencodeSession({
    opencodeInstanceId: instance.id,
    opencodeSessionId,
    agent: "triage",
    createdAt: now,
  });
  await createSparkTriage({
    sparkId: spark.id,
    opencodeSessionId,
    triagePath: spark.triagePath,
    createdAt: now,
  });

  const promptTemplate = await loadPrompt(rootPath, "triage.md");
  const firstMessage = renderPrompt(promptTemplate, {
    sparkId: spark.id,
    sparkWorkingPath: spark.workingPath,
    sparkOriginalPath: spark.originalPath,
    sparkTriagePath: spark.triagePath,
    workstreamsRoot: `${rootPath}/workstreams`,
    triageSchemaJson: JSON.stringify(TRIAGE_DOCUMENT_SCHEMA_JSON, null, 2),
  });

  await client.session.promptAsync({
    sessionID: opencodeSessionId,
    parts: [
      {
        type: "text",
        text: firstMessage,
      },
    ],
  });
}

export async function handleOpencodeGlobalEvent(input: {
  instanceBaseUrl: string;
  rootPath: string;
  payload: unknown;
}): Promise<void> {
  if (!input.payload || typeof input.payload !== "object") {
    return;
  }

  const type = Reflect.get(input.payload, "type");
  const properties = Reflect.get(input.payload, "properties");
  const eventSessionId =
    properties && typeof properties === "object"
      ? typeof Reflect.get(properties, "sessionID") === "string"
        ? (Reflect.get(properties, "sessionID") as string)
        : getMessageSessionId(properties)
      : undefined;

  console.log("[triage-debug][global-event]", {
    type,
    sessionId: eventSessionId,
  });

  if (type === "message.updated") {
    const sessionId = getMessageSessionId(properties);
    const role = getMessageRole(properties);
    if (!sessionId || !role) {
      return;
    }

    await setOpencodeSessionLastMessageRole({
      opencodeSessionId: sessionId,
      role,
      updatedAt: new Date(),
    });
    return;
  }

  if (type !== "session.status") {
    return;
  }

  if (!properties || typeof properties !== "object") {
    return;
  }

  const sessionId = Reflect.get(properties, "sessionID");
  const statusRaw = Reflect.get(properties, "status");
  if (typeof sessionId !== "string") {
    return;
  }

  const statusType = statusToType(statusRaw);
  if (!statusType) {
    return;
  }

  const sessionRow = await findOpencodeSessionByExternalId(sessionId);
  const waitingOnUser =
    statusType === "idle" && sessionRow?.lastMessageRole === "assistant";
  await setOpencodeSessionStatus({
    opencodeSessionId: sessionId,
    statusType,
    waitingOnUser,
    statusUpdatedAt: new Date(),
  });

  if (statusType !== "idle") {
    return;
  }

  await validateTriageAfterIdle({
    sessionId,
    baseUrl: input.instanceBaseUrl,
    rootPath: input.rootPath,
  });
}
