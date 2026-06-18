import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { Effect } from 'effect';

import { HarnessAdapterError } from './types.js';

export interface HarnessIntegrationArtifacts {
  readonly piExtensionPath: string;
  readonly opencodePluginPath: string;
  readonly claudeSettingsPath: string;
  readonly claudeHookPath: string;
  readonly codexHookPath: string;
}

export function prepareHarnessIntegrationArtifacts(dataRoot: string) {
  return Effect.try({
    try: () => {
      const artifacts = artifactPaths(dataRoot);
      writeArtifact(artifacts.piExtensionPath, piExtensionSource());
      writeArtifact(artifacts.opencodePluginPath, opencodePluginSource());
      writeArtifact(artifacts.claudeHookPath, commandHookSource());
      writeArtifact(
        artifacts.claudeSettingsPath,
        `${JSON.stringify(claudeSettings(artifacts.claudeHookPath), null, 2)}\n`,
      );
      writeArtifact(artifacts.codexHookPath, commandHookSource());
      console.info('[runtime] Harness integration artifacts prepared', {
        piExtensionPath: artifacts.piExtensionPath,
        opencodePluginPath: artifacts.opencodePluginPath,
        claudeSettingsPath: artifacts.claudeSettingsPath,
        codexHookPath: artifacts.codexHookPath,
      });
      return artifacts;
    },
    catch: (cause) =>
      new HarnessAdapterError(
        'artifact_write_failed',
        'Could not write runtime-owned harness integration artifacts.',
        cause,
      ),
  });
}

function artifactPaths(dataRoot: string): HarnessIntegrationArtifacts {
  const root = resolve(dataRoot, 'harness-integrations');
  return {
    piExtensionPath: resolve(root, 'pi', 'isagi-session.ts'),
    opencodePluginPath: resolve(root, 'opencode', 'isagi-session-plugin.js'),
    claudeSettingsPath: resolve(root, 'claude', 'settings.json'),
    claudeHookPath: resolve(root, 'claude', 'isagi-claude-hook.mjs'),
    codexHookPath: resolve(root, 'codex', 'isagi-codex-hook.mjs'),
  };
}

function writeArtifact(path: string, source: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source, 'utf8');
}

function claudeSettings(hookPath: string) {
  const hook = {
    type: 'command',
    command: `node ${shellQuote(hookPath)}`,
    timeout: 2,
  } as const;
  const hookEntry = { hooks: [hook] } as const;
  return {
    hooks: {
      UserPromptSubmit: [hookEntry],
    },
  };
}

function piExtensionSource() {
  return String.raw`${writeHarnessMetadataSource({ typescript: true })}

async function observe(source: string, ctx: any) {
  const sessionId = ctx?.sessionManager?.getSessionId?.();
  await writeHarnessMetadata(sessionId);
}

export default function (pi: any) {
  pi.on("agent_start", async (_event, ctx) => observe("agent_start", ctx));
}
`;
}

function opencodePluginSource() {
  return String.raw`${writeHarnessMetadataSource()}

function sessionIdFromEvent(event) {
  const properties = event?.properties;
  return (
    properties?.sessionID ??
    properties?.sessionId ??
    properties?.session?.id ??
    properties?.info?.id ??
    null
  );
}

function sessionIdFromHookInput(input) {
  return input?.sessionID ?? input?.sessionId ?? input?.session?.id ?? null;
}

export const IsagiSessionObserver = async () => {
  return {
    event: async ({ event }) => {
      if (!event) return;
      if (
        event.type === "session.created" ||
        event.type === "session.updated" ||
        event.type === "session.idle" ||
        event.type === "session.status"
      ) {
        await writeHarnessMetadata(sessionIdFromEvent(event));
      }
    },
    "chat.params": async (input) => {
      await writeHarnessMetadata(sessionIdFromHookInput(input));
    },
    "chat.message": async (input) => {
      await writeHarnessMetadata(sessionIdFromHookInput(input));
    },
  };
};
`;
}

function commandHookSource() {
  return String.raw`${writeHarnessMetadataSource()}

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
await writeHarnessMetadata(sessionId);
`;
}

function writeHarnessMetadataSource(options: { readonly typescript?: boolean } = {}) {
  const params = options.typescript
    ? 'harnessSessionId: string | null | undefined'
    : 'harnessSessionId';
  return String.raw`const metadataPath = process.env.ISAGI_HARNESS_METADATA_PATH;
const agentSessionId = Number(process.env.ISAGI_AGENT_SESSION_ID ?? "");
const ptyProcessId = Number(process.env.ISAGI_PTY_PROCESS_ID ?? "");

async function writeHarnessMetadata(${params}) {
  if (
    !metadataPath ||
    !harnessSessionId ||
    !Number.isSafeInteger(agentSessionId) ||
    agentSessionId <= 0 ||
    !Number.isSafeInteger(ptyProcessId) ||
    ptyProcessId <= 0
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

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
