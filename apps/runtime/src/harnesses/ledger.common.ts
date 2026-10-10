import type { AgentHarness } from '@isagi/contracts';

export function commandHookSource(
  harness: 'claude' | 'codex',
  options: { readonly persistHarnessSessionId?: boolean } = {},
) {
  const persistHarnessSessionId = options.persistHarnessSessionId ?? true;
  return String.raw`${writeHarnessMetadataSource()}
${appendHarnessEventSource(harness)}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return { ok: false, reason: "empty_stdin" };
  try {
    const input = JSON.parse(raw);
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return { ok: false, reason: "invalid_envelope" };
    }
    return { ok: true, input };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}

const stdin = await readStdinJson();
if (!stdin.ok) {
  console.error("[isagi] Harness observation skipped: malformed hook input.");
} else {
  const sessionId = typeof stdin.input.session_id === "string" && stdin.input.session_id ? stdin.input.session_id : null;
  const nativeEvent = typeof stdin.input.hook_event_name === "string" && stdin.input.hook_event_name ? stdin.input.hook_event_name : null;
  if (!sessionId || !nativeEvent) {
    console.error("[isagi] Harness observation skipped: malformed hook input.");
  } else {
    if (${JSON.stringify(persistHarnessSessionId)}) await writeHarnessMetadata(sessionId);
    await appendHarnessEvent(sessionId, nativeEvent, safeJsonValue(stdin.input));
  }
}
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
    if (!(await ensureSecureArtifactDirectory(fs))) return;
    const file = await openSecureArtifactFile(fs, metadataPath, "w");
    if (!file) return;
    try {
      await file.writeFile(
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
    } finally {
      await file.close();
    }
  } catch {
    // Observation must never block or fail the user's harness interaction.
  }
}

async function ensureSecureArtifactDirectory(fs) {
  if (!harnessArtifactDirectory) return false;
  try {
    await fs.mkdir(harnessArtifactDirectory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(harnessArtifactDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    if (process.platform === "win32") return true;
    await fs.chmod(harnessArtifactDirectory, 0o700);
    return ((await fs.lstat(harnessArtifactDirectory)).mode & 0o777) === 0o700;
  } catch {
    return false;
  }
}

async function openSecureArtifactFile(fs, path, mode) {
  try {
    try {
      const stat = await fs.lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      if (process.platform !== "win32") await fs.chmod(path, 0o600);
    } catch (error) {
      if (error?.code !== "ENOENT") return null;
    }
    const nodeFs = await import("node:fs");
    const flags = mode === "a" ? nodeFs.constants.O_APPEND | nodeFs.constants.O_CREAT | nodeFs.constants.O_WRONLY : nodeFs.constants.O_CREAT | nodeFs.constants.O_TRUNC | nodeFs.constants.O_WRONLY;
    if (process.platform !== "win32" && !nodeFs.constants.O_NOFOLLOW) return null;
    const file = await fs.open(
      path,
      flags | (process.platform === "win32" ? 0 : nodeFs.constants.O_NOFOLLOW),
      0o600,
    );
    const stat = await file.stat();
    if (!stat.isFile()) {
      await file.close();
      return null;
    }
    if (process.platform !== "win32") await file.chmod(0o600);
    return file;
  } catch {
    return null;
  }
}
`;
}

// Single source of truth for the harness JSONL record shape. Every harness hook
// (command-based and plugin-based) emits this same `appendHarnessEvent` plus its
// `safeJsonValue`/`harnessSessionLogFileName` helpers, so the on-disk record
// schema and the log-file naming live in exactly one place. The reader in
// `agent-sessions/harness/ledger.ts` (`parseJsonlRecord`) must stay in lockstep.
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
    if (!(await ensureSecureArtifactDirectory(fs))) return;
    const jsonlPath = path.join(
      harnessArtifactDirectory,
      harnessSessionLogFileName(harnessSessionId),
    );
    const file = await openSecureArtifactFile(fs, jsonlPath, "a");
    if (!file) return;
    try {
      await file.writeFile(
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
    } finally {
      await file.close();
    }
  } catch {
    // Observation must never block or fail the user's harness interaction.
  }
}
`;
}

export function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
