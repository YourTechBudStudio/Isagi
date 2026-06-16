import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { Effect } from 'effect';

import type { HarnessEventTokenRegistryService } from '../harness-events/token-registry.js';
import { launchEnv } from '../pty-processes/service/runtime-namespace.js';
import { HarnessAdapterError, type HarnessLaunchContext } from './types.js';

export function buildPiLaunch(
  input: HarnessLaunchContext,
  dependencies: {
    readonly dataRoot: string;
    readonly eventUrl: string;
    readonly tokens: HarnessEventTokenRegistryService;
  },
) {
  return Effect.gen(function* () {
    const extensionPath = yield* ensurePiExtension(dependencies.dataRoot);
    return {
      command: 'pi',
      args: [
        ...(input.latestHarnessSessionId ? ['--session', input.latestHarnessSessionId] : []),
        '--no-extensions',
        '-e',
        extensionPath,
      ],
      cwd: input.cwd,
      envForProcess: ({ ptyProcessId }: { readonly ptyProcessId: number }) =>
        dependencies.tokens
          .create({
            agentSessionId: input.agentSessionId,
            ptyProcessId,
            harness: 'pi' as const,
          })
          .pipe(
            Effect.map((token) => ({
              ...launchEnv(),
              ISAGI_AGENT_SESSION_ID: String(input.agentSessionId),
              ISAGI_HARNESS_EVENT_URL: dependencies.eventUrl,
              ISAGI_HARNESS_EVENT_TOKEN: token.token,
            })),
          ),
    };
  });
}

function ensurePiExtension(dataRoot: string) {
  return Effect.try({
    try: () => {
      const extensionPath = resolve(dataRoot, 'harness-integrations', 'pi', 'isagi-session.ts');
      mkdirSync(dirname(extensionPath), { recursive: true });
      writeFileSync(extensionPath, piExtensionSource(), 'utf8');
      return extensionPath;
    },
    catch: (cause) =>
      new HarnessAdapterError(
        'artifact_write_failed',
        'Could not write runtime-owned Pi harness extension.',
        cause,
      ),
  });
}

function piExtensionSource() {
  return String.raw`import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const eventUrl = process.env.ISAGI_HARNESS_EVENT_URL;
const eventToken = process.env.ISAGI_HARNESS_EVENT_TOKEN;
const agentSessionId = Number(process.env.ISAGI_AGENT_SESSION_ID ?? "");

async function observe(source: string, ctx: ExtensionContext) {
  if (!eventUrl || !eventToken || !Number.isSafeInteger(agentSessionId) || agentSessionId <= 0) {
    return;
  }
  const sessionId = ctx.sessionManager.getSessionId();
  if (!sessionId) return;
  try {
    await fetch(eventUrl, {
      method: "POST",
      headers: {
        "authorization": "Bearer " + eventToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "harness_session_observed",
        harness: "pi",
        harnessSessionId: sessionId,
        source,
        agentSessionId,
      }),
    });
  } catch {
    // Observation must never block or fail the user's harness interaction.
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => observe("session_start", ctx));
  pi.on("agent_start", async (_event, ctx) => observe("agent_start", ctx));
  pi.on("turn_start", async (_event, ctx) => observe("turn_start", ctx));
}
`;
}
