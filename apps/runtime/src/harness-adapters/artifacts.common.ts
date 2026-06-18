import type { AgentHarness } from '@isagi/contracts';

export function commandHookSource(harness: 'claude' | 'codex') {
  return String.raw`${writeHarnessMetadataSource()}
${appendHarnessEventSource(harness)}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const input = await readStdinJson();
const sessionId = typeof input.session_id === "string" ? input.session_id : null;
const nativeEvent = typeof input.hook_event_name === "string" ? input.hook_event_name : null;
await writeHarnessMetadata(sessionId);
await appendHarnessEvent(sessionId, nativeEvent, {
  nativeEvent,
  notificationType: typeof input.notification_type === "string" ? input.notification_type : null,
  input: safeJsonValue(input),
});
`;
}

export function writeHarnessMetadataSource(options: { readonly typescript?: boolean } = {}) {
  const params = options.typescript
    ? 'harnessSessionId: string | null | undefined'
    : 'harnessSessionId';
  return String.raw`const metadataPath = process.env.ISAGI_HARNESS_METADATA_PATH;
const harnessArtifactDirectory = process.env.ISAGI_HARNESS_ARTIFACT_DIRECTORY;
const agentSessionId = Number(process.env.ISAGI_AGENT_SESSION_ID ?? "");
const ptyProcessId = Number(process.env.ISAGI_PTY_PROCESS_ID ?? "");

async function writeHarnessMetadata(${params}) {
  if (
    !metadataPath ||
    !harnessSessionId ||
    !Number.isSafeInteger(agentSessionId) ||
    agentSessionId <= 0
  ) {
    return;
  }
  try {
    const fs = await import("node:fs/promises");
    await fs.access(metadataPath);
    await fs.writeFile(
      metadataPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          harnessSessionId,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
  } catch {
    // Observation must never block or fail the user's harness interaction.
  }
}
`;
}

// Single source of truth for the harness JSONL record shape. Every harness hook
// (command-based and plugin-based) emits this same `appendHarnessEvent` plus its
// `safeJsonValue`/`harnessSessionLogFileName` helpers, so the on-disk record
// schema and the log-file naming live in exactly one place. The reader in
// `agent-sessions/artifacts.ts` (`parseJsonlRecord`) must stay in lockstep.
export function appendHarnessEventSource(harness: AgentHarness) {
  return String.raw`function safeJsonValue(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return null;
  }
}

function harnessSessionLogFileName(harnessSessionId) {
  return Buffer.from(harnessSessionId, "utf8").toString("hex") + ".harness.jsonl";
}

async function appendHarnessEvent(harnessSessionId, nativeEvent, event) {
  if (
    !harnessArtifactDirectory ||
    !harnessSessionId ||
    !nativeEvent ||
    !Number.isSafeInteger(agentSessionId) ||
    agentSessionId <= 0
  ) {
    return;
  }
  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    await fs.mkdir(harnessArtifactDirectory, { recursive: true });
    const jsonlPath = path.join(
      harnessArtifactDirectory,
      harnessSessionLogFileName(harnessSessionId),
    );
    await fs.appendFile(
      jsonlPath,
      JSON.stringify({
        schemaVersion: 1,
        recordedAt: new Date().toISOString(),
        agentSessionId,
        harnessSessionId,
        ptyProcessId: Number.isSafeInteger(ptyProcessId) && ptyProcessId > 0 ? ptyProcessId : null,
        harness: ${JSON.stringify(harness)},
        nativeEvent,
        event,
      }) + "\n",
      "utf8",
    );
  } catch {
    // Observation must never block or fail the user's harness interaction.
  }
}
`;
}

export function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
