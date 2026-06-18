import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { Effect, Either } from 'effect';

import type { AgentSessionArtifactsService } from '../agent-sessions/index.js';
import { prepareHarnessIntegrationArtifacts } from './artifacts.js';
import { buildClaudeLaunch } from './claude.adapter.js';
import { buildCodexLaunch } from './codex.adapter.js';
import { buildOpenCodeLaunch } from './opencode.adapter.js';
import { buildPiLaunch } from './pi.adapter.js';
import { HarnessAdapterError } from './types.js';

test('Pi adapter builds a fresh launch envelope with runtime-owned extension injection', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-harness-artifacts-'));
  try {
    const artifacts = await Effect.runPromise(prepareHarnessIntegrationArtifacts(dataRoot));
    const sessionArtifacts = fakeArtifacts(dataRoot);
    const launch = await Effect.runPromise(
      buildPiLaunch(
        {
          agentSessionId: 10,
          harness: 'pi',
          cwd: '/repo/isagi',
          latestHarnessSessionId: null,
        },
        {
          extensionPath: artifacts.piExtensionPath,
          artifacts: sessionArtifacts,
        },
      ),
    );

    assert.equal(launch.command, 'pi');
    assert.deepEqual(launch.args, ['-e', artifacts.piExtensionPath]);
    assert.equal(launch.args.includes('--no-extensions'), false);
    assert.equal(launch.cwd, '/repo/isagi');

    const extensionSource = readFileSync(artifacts.piExtensionPath, 'utf8');
    assert.match(extensionSource, /agent_start/);
    assert.match(extensionSource, /agent_end/);
    assert.doesNotMatch(extensionSource, /session_start/);
    assert.doesNotMatch(extensionSource, /turn_start/);
    assert.doesNotMatch(extensionSource, /turn_end/);
    assert.match(extensionSource, /ISAGI_HARNESS_JSONL_PATH/);
    assert.match(extensionSource, /ISAGI_HARNESS_METADATA_PATH/);
    assert.match(extensionSource, /writeHarnessMetadata/);
    assert.doesNotMatch(extensionSource, /ISAGI_HARNESS_EVENT_URL/);
    assert.doesNotMatch(extensionSource, /@earendil-works\/pi-coding-agent/);

    const env = await Effect.runPromise(
      launch.envForProcess?.({ ptyProcessId: 20 }) ?? Effect.succeed({}),
    );
    assert.equal(env.ISAGI_AGENT_SESSION_ID, '10');
    assert.equal(env.ISAGI_PTY_PROCESS_ID, '20');
    assert.equal(
      env.ISAGI_HARNESS_METADATA_PATH,
      resolve(dataRoot, 'sessions', 'agent-sessions', '10', 'harness.json'),
    );
    assert.equal(
      env.ISAGI_HARNESS_JSONL_PATH,
      resolve(dataRoot, 'sessions', 'agent-sessions', '10', '20.harness.jsonl'),
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('Pi adapter resumes using the latest observed harness session id', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pi-adapter-resume-'));
  try {
    const artifacts = await Effect.runPromise(prepareHarnessIntegrationArtifacts(dataRoot));
    const launch = await Effect.runPromise(
      buildPiLaunch(
        {
          agentSessionId: 10,
          harness: 'pi',
          cwd: '/repo/isagi',
          latestHarnessSessionId: 'pi-session-123',
        },
        {
          extensionPath: artifacts.piExtensionPath,
          artifacts: fakeArtifacts(dataRoot),
        },
      ),
    );

    assert.deepEqual(launch.args, ['--session', 'pi-session-123', '-e', artifacts.piExtensionPath]);
    assert.equal(launch.args.includes('--no-extensions'), false);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('harness integration artifacts are prepared once under the runtime data root', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-harness-artifacts-'));
  try {
    const artifacts = await Effect.runPromise(prepareHarnessIntegrationArtifacts(dataRoot));

    assert.equal(
      artifacts.piExtensionPath,
      resolve(dataRoot, 'harness-integrations', 'pi', 'isagi-session.ts'),
    );
    assert.equal(
      artifacts.opencodePluginPath,
      resolve(dataRoot, 'harness-integrations', 'opencode', 'isagi-session-plugin.js'),
    );
    assert.equal(
      artifacts.claudeSettingsPath,
      resolve(dataRoot, 'harness-integrations', 'claude', 'settings.json'),
    );
    assert.equal(
      artifacts.codexHookPath,
      resolve(dataRoot, 'harness-integrations', 'codex', 'isagi-codex-hook.mjs'),
    );

    const opencodeSource = readFileSync(artifacts.opencodePluginPath, 'utf8');
    assert.match(opencodeSource, /session\.created/);
    assert.match(opencodeSource, /session\.status/);
    assert.match(opencodeSource, /appendOpenCodeHarnessEvent/);
    assert.match(opencodeSource, /chat\.params/);
    assert.match(opencodeSource, /ISAGI_HARNESS_METADATA_PATH/);
    assert.match(opencodeSource, /ISAGI_HARNESS_JSONL_PATH/);
    assert.doesNotMatch(opencodeSource, /session\.idle/);
    assert.doesNotMatch(opencodeSource, /ISAGI_HARNESS_EVENT_URL/);

    const claudeSettings = JSON.parse(readFileSync(artifacts.claudeSettingsPath, 'utf8'));
    assert.equal(claudeSettings.hooks.UserPromptSubmit[0].hooks[0].type, 'command');
    assert.match(
      claudeSettings.hooks.UserPromptSubmit[0].hooks[0].command,
      /isagi-claude-hook\.mjs/,
    );
    assert.equal(claudeSettings.hooks.UserPromptSubmit[0].hooks[0].timeout, 2);
    assert.equal(claudeSettings.hooks.SessionStart, undefined);
    assert.equal(claudeSettings.hooks.Stop, undefined);
    assert.equal(claudeSettings.hooks.SessionEnd, undefined);

    const claudeHook = readFileSync(artifacts.claudeHookPath, 'utf8');
    assert.match(claudeHook, /session_id/);
    assert.match(claudeHook, /ISAGI_HARNESS_METADATA_PATH/);
    assert.doesNotMatch(claudeHook, /ISAGI_HARNESS_EVENT_URL/);

    const codexHook = readFileSync(artifacts.codexHookPath, 'utf8');
    assert.match(codexHook, /session_id/);
    assert.match(codexHook, /ISAGI_HARNESS_METADATA_PATH/);
    assert.doesNotMatch(codexHook, /ISAGI_HARNESS_EVENT_URL/);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('harness artifact preparation fails when the runtime data root cannot host artifacts', async () => {
  const dataRoot = join(tmpdir(), `isagi-harness-artifact-file-${Date.now()}`);
  writeFileSync(dataRoot, 'not a directory', 'utf8');
  try {
    const result = await Effect.runPromise(
      prepareHarnessIntegrationArtifacts(dataRoot).pipe(Effect.either),
    );
    assert.equal(Either.isLeft(result), true);
    assert.equal(
      Either.isLeft(result) && result.left instanceof HarnessAdapterError
        ? result.left.code
        : undefined,
      'artifact_write_failed',
    );
  } finally {
    rmSync(dataRoot, { force: true });
  }
});

test('OpenCode adapter launches from cwd and injects runtime config content', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-opencode-adapter-'));
  const launch = await Effect.runPromise(
    buildOpenCodeLaunch(
      {
        agentSessionId: 10,
        harness: 'opencode',
        cwd: '/repo/isagi',
        latestHarnessSessionId: null,
      },
      {
        pluginPath: '/runtime/harness-integrations/opencode/isagi-session-plugin.js',
        artifacts: fakeArtifacts(dataRoot),
      },
    ),
  );

  assert.equal(launch.command, 'opencode');
  assert.deepEqual(launch.args, []);
  assert.equal(launch.cwd, '/repo/isagi');

  const env = (await Effect.runPromise(
    launch.envForProcess?.({ ptyProcessId: 20 }) ?? Effect.succeed({}),
  )) as NodeJS.ProcessEnv;
  assert.equal(env.ISAGI_AGENT_SESSION_ID, '10');
  assert.equal(env.ISAGI_PTY_PROCESS_ID, '20');
  assert.match(env.ISAGI_HARNESS_METADATA_PATH ?? '', /harness\.json$/);
  assert.match(env.ISAGI_HARNESS_JSONL_PATH ?? '', /20\.harness\.jsonl$/);
  assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}'), {
    plugin: ['file:///runtime/harness-integrations/opencode/isagi-session-plugin.js'],
  });
  assert.equal(env.OPENCODE_PURE, undefined);
  rmSync(dataRoot, { recursive: true, force: true });
});

test('OpenCode adapter resumes using --session from cwd without a project argument', async () => {
  const launch = await Effect.runPromise(
    buildOpenCodeLaunch(
      {
        agentSessionId: 10,
        harness: 'opencode',
        cwd: '/repo/isagi',
        latestHarnessSessionId: 'opencode-session-123',
      },
      {
        pluginPath: '/runtime/harness-integrations/opencode/isagi-session-plugin.js',
        artifacts: fakeArtifacts('/runtime'),
      },
    ),
  );

  assert.deepEqual(launch.args, ['--session', 'opencode-session-123']);
  assert.equal(launch.cwd, '/repo/isagi');
});

test('Claude adapter uses runtime-owned settings and resumes from cwd', async () => {
  const launch = await Effect.runPromise(
    buildClaudeLaunch(
      {
        agentSessionId: 10,
        harness: 'claude',
        cwd: '/repo/isagi',
        latestHarnessSessionId: 'claude-session-123',
      },
      {
        settingsPath: '/runtime/harness-integrations/claude/settings.json',
        artifacts: fakeArtifacts('/runtime'),
      },
    ),
  );

  assert.equal(launch.command, 'claude');
  assert.deepEqual(launch.args, [
    '--resume',
    'claude-session-123',
    '--settings',
    '/runtime/harness-integrations/claude/settings.json',
  ]);
  assert.equal(launch.args.includes('--session-id'), false);
  assert.equal(launch.cwd, '/repo/isagi');

  const env = await Effect.runPromise(
    launch.envForProcess?.({ ptyProcessId: 20 }) ?? Effect.succeed({}),
  );
  assert.equal(env.ISAGI_AGENT_SESSION_ID, '10');
  assert.equal(env.ISAGI_PTY_PROCESS_ID, '20');
  assert.match(env.ISAGI_HARNESS_METADATA_PATH ?? '', /harness\.json$/);
});

test('Codex adapter injects process-scoped hooks and resumes from cwd', async () => {
  const launch = await Effect.runPromise(
    buildCodexLaunch(
      {
        agentSessionId: 10,
        harness: 'codex',
        cwd: '/repo/isagi',
        latestHarnessSessionId: 'codex-session-123',
      },
      {
        hookPath: '/runtime/harness-integrations/codex/isagi-codex-hook.mjs',
        artifacts: fakeArtifacts('/runtime'),
      },
    ),
  );

  assert.equal(launch.command, 'codex');
  assert.equal(launch.args.includes('--enable'), true);
  assert.equal(launch.args.includes('hooks'), true);
  assert.equal(launch.args.includes('--dangerously-bypass-hook-trust'), true);
  assert.equal(launch.args.includes('--cd'), false);
  assert.deepEqual(launch.args.slice(-2), ['resume', 'codex-session-123']);
  assert.match(launch.args.join(' '), /hooks\.SessionStart/);
  assert.match(launch.args.join(' '), /hooks\.UserPromptSubmit/);
  assert.match(launch.args.join(' '), /hooks\.Stop/);
  assert.match(launch.args.join(' '), /isagi-codex-hook\.mjs/);
  assert.equal(launch.cwd, '/repo/isagi');

  const env = await Effect.runPromise(
    launch.envForProcess?.({ ptyProcessId: 20 }) ?? Effect.succeed({}),
  );
  assert.equal(env.ISAGI_AGENT_SESSION_ID, '10');
  assert.equal(env.ISAGI_PTY_PROCESS_ID, '20');
  assert.match(env.ISAGI_HARNESS_METADATA_PATH ?? '', /harness\.json$/);
});

function fakeArtifacts(root: string): AgentSessionArtifactsService {
  return {
    paths: (input) => {
      const directory = resolve(root, 'sessions', 'agent-sessions', String(input.agentSessionId));
      return {
        directory,
        metadataPath: resolve(directory, 'harness.json'),
        jsonlPath: input.ptyProcessId
          ? resolve(directory, `${input.ptyProcessId}.harness.jsonl`)
          : null,
      };
    },
    initializeMetadata: () => Effect.void,
    prepareProcessArtifacts: (input) => Effect.succeed(fakeArtifacts(root).paths(input)),
    readMetadata: () =>
      Effect.succeed({
        status: 'valid',
        metadataPath: resolve(root, 'sessions', 'agent-sessions', '10', 'harness.json'),
        metadata: {
          schemaVersion: 1,
          harnessSessionId: null,
          updatedAt: '2026-06-16T00:00:00.000Z',
        },
      }),
    readJsonl: (input) =>
      Effect.succeed({
        path:
          fakeArtifacts(root).paths({
            agentSessionId: input.agentSessionId,
            ptyProcessId: input.ptyProcessId,
          }).jsonlPath ?? root,
        records: [],
        ignoredLineCount: 0,
      }),
    readJsonlForAgentSession: () => Effect.succeed([]),
    listAgentSessionIds: Effect.succeed([]),
    writeHarnessSessionId: () => Effect.void,
    removeDirectory: () => Effect.void,
  } satisfies AgentSessionArtifactsService;
}
