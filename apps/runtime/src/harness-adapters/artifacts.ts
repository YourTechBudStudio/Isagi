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
      writeArtifact(artifacts.claudeHookPath, commandHookSource('claude'));
      writeArtifact(
        artifacts.claudeSettingsPath,
        `${JSON.stringify(claudeSettings(artifacts.claudeHookPath), null, 2)}\n`,
      );
      writeArtifact(artifacts.codexHookPath, commandHookSource('codex'));
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
      SessionStart: [hookEntry],
      UserPromptSubmit: [hookEntry],
      Stop: [hookEntry],
      SessionEnd: [hookEntry],
    },
  };
}

function piExtensionSource() {
  return String.raw`${postObservationSource('pi', { typescript: true })}

async function observe(source: string, ctx: any) {
  const sessionId = ctx?.sessionManager?.getSessionId?.();
  await postObservation(sessionId, source);
}

export default function (pi: any) {
  pi.on("session_start", async (_event, ctx) => observe("session_start", ctx));
  pi.on("agent_start", async (_event, ctx) => observe("agent_start", ctx));
  pi.on("turn_start", async (_event, ctx) => observe("turn_start", ctx));
}
`;
}

function opencodePluginSource() {
  return String.raw`${postObservationSource('opencode')}

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
        await postObservation(sessionIdFromEvent(event), event.type);
      }
    },
    "chat.params": async (input) => {
      await postObservation(sessionIdFromHookInput(input), "chat.params");
    },
    "chat.message": async (input) => {
      await postObservation(sessionIdFromHookInput(input), "chat.message");
    },
  };
};
`;
}

function commandHookSource(harness: 'claude' | 'codex') {
  return String.raw`${postObservationSource(harness)}

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
const source = typeof input.hook_event_name === "string" ? input.hook_event_name : null;
await postObservation(sessionId, source);
`;
}

function postObservationSource(
  harness: 'pi' | 'opencode' | 'claude' | 'codex',
  options: { readonly typescript?: boolean } = {},
) {
  const params = options.typescript
    ? 'harnessSessionId: string | null | undefined, source: string | null'
    : 'harnessSessionId, source';
  return String.raw`const eventUrl = process.env.ISAGI_HARNESS_EVENT_URL;
const eventToken = process.env.ISAGI_HARNESS_EVENT_TOKEN;
const agentSessionId = Number(process.env.ISAGI_AGENT_SESSION_ID ?? "");

async function postObservation(${params}) {
  if (
    !eventUrl ||
    !eventToken ||
    !harnessSessionId ||
    !Number.isSafeInteger(agentSessionId) ||
    agentSessionId <= 0
  ) {
    return;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1000);
  try {
    await fetch(eventUrl, {
      method: "POST",
      headers: {
        "authorization": "Bearer " + eventToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "harness_session_observed",
        harness: "${harness}",
        harnessSessionId,
        source: source ?? null,
        agentSessionId,
      }),
      signal: controller.signal,
    });
  } catch {
    // Observation must never block or fail the user's harness interaction.
  } finally {
    clearTimeout(timeout);
  }
}
`;
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
