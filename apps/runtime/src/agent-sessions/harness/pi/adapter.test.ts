import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { Effect, Either } from 'effect';

import { prepareHarnessIntegrationArtifacts } from '../artifacts.js';
import { buildClaudeHeadlessLaunch, buildClaudeLaunch } from '../claude/adapter.js';
import { buildCodexHeadlessLaunch, buildCodexLaunch } from '../codex/adapter.js';
import type { AgentSessionArtifactsService } from '../ledger.js';
import { buildOpenCodeHeadlessLaunch, buildOpenCodeLaunch } from '../opencode/adapter.js';
import { HarnessAdapterError } from '../types.js';
import { buildPiHeadlessLaunch, buildPiLaunch } from './adapter.js';

const runtimeUrl = 'http://runtime.test';

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
          skillDirectory: artifacts.configureIsagiSkill.skillDirectory,
          artifacts: sessionArtifacts,
          runtimeUrl,
        },
      ),
    );

    assert.equal(launch.command, 'pi');
    assert.deepEqual(launch.args, [
      '--skill',
      artifacts.configureIsagiSkill.skillDirectory,
      '-e',
      artifacts.piExtensionPath,
    ]);
    assert.equal(launch.args.includes('--no-extensions'), false);
    assert.equal(launch.cwd, '/repo/isagi');
    assert.equal(launch.launchMode, 'user_shell');

    const extensionSource = readFileSync(artifacts.piExtensionPath, 'utf8');
    assert.match(extensionSource, /agent_start/);
    assert.match(extensionSource, /agent_end/);
    assert.match(extensionSource, /agent_error/);
    assert.match(extensionSource, /message_end/);
    assert.match(extensionSource, /stopReason/);
    assert.doesNotMatch(extensionSource, /safeJsonValue\(event\)/);
    assert.doesNotMatch(extensionSource, /content/);
    assert.doesNotMatch(extensionSource, /toolResult/);
    assert.doesNotMatch(extensionSource, /beforeAgentStart/);
    assert.doesNotMatch(extensionSource, /lastBeforeAgentStart/);
    assert.doesNotMatch(extensionSource, /session_start/);
    assert.doesNotMatch(extensionSource, /turn_start/);
    assert.doesNotMatch(extensionSource, /turn_end/);
    assert.match(extensionSource, /ISAGI_HARNESS_ARTIFACT_DIRECTORY/);
    assert.doesNotMatch(extensionSource, /ISAGI_HARNESS_JSONL_PATH/);
    assert.match(extensionSource, /ISAGI_HARNESS_METADATA_PATH/);
    assert.match(extensionSource, /writeHarnessMetadata/);
    assert.doesNotMatch(extensionSource, /ISAGI_HARNESS_EVENT_URL/);
    assert.doesNotMatch(extensionSource, /@earendil-works\/pi-coding-agent/);

    const env = await Effect.runPromise(
      launch.envForProcess?.({ ptyProcessId: 20 }) ?? Effect.succeed({}),
    );
    assert.equal(env.ISAGI_AGENT_SESSION_ID, '10');
    assert.equal(env.ISAGI_RUNTIME_URL, runtimeUrl);
    assert.equal(env.ISAGI_PTY_PROCESS_ID, '20');
    assert.equal(
      env.ISAGI_HARNESS_METADATA_PATH,
      resolve(dataRoot, 'sessions', 'agent-sessions', '10', 'harness.json'),
    );
    assert.equal(
      env.ISAGI_HARNESS_ARTIFACT_DIRECTORY,
      resolve(dataRoot, 'sessions', 'agent-sessions', '10'),
    );
    assert.equal('ISAGI_HARNESS_JSONL_PATH' in env, false);
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
          skillDirectory: artifacts.configureIsagiSkill.skillDirectory,
          artifacts: fakeArtifacts(dataRoot),
          runtimeUrl,
        },
      ),
    );

    assert.deepEqual(launch.args, [
      '--session',
      'pi-session-123',
      '--skill',
      artifacts.configureIsagiSkill.skillDirectory,
      '-e',
      artifacts.piExtensionPath,
    ]);
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
    assert.equal(
      artifacts.configureIsagiSkill.skillDirectory,
      resolve(dataRoot, 'skills', 'shared', 'configure-isagi'),
    );
    assert.equal(
      artifacts.configureIsagiSkill.skillScanDirectory,
      resolve(dataRoot, 'skills', 'shared'),
    );
    assert.equal(
      artifacts.configureIsagiSkill.claudeSkillWorkspaceDirectory,
      resolve(dataRoot, 'harness-integrations', 'claude', 'skill-workspace'),
    );

    const opencodeSource = readFileSync(artifacts.opencodePluginPath, 'utf8');
    assert.match(opencodeSource, /session\.created/);
    assert.match(opencodeSource, /session\.status/);
    assert.match(opencodeSource, /session\.idle/);
    assert.match(opencodeSource, /session\.error/);
    assert.doesNotMatch(opencodeSource, /message\.updated/);
    assert.doesNotMatch(opencodeSource, /message\.part\.updated/);
    assert.match(opencodeSource, /appendHarnessEvent/);
    assert.match(opencodeSource, /harness: "opencode"/);
    assert.match(opencodeSource, /chat\.params/);
    assert.match(opencodeSource, /chat\.message/);
    assert.doesNotMatch(opencodeSource, /output: safeJsonValue/);
    assert.doesNotMatch(opencodeSource, /input: safeJsonValue/);
    assert.doesNotMatch(opencodeSource, /completedAssistantMessageIds/);
    assert.doesNotMatch(opencodeSource, /completedTextPartIds/);
    assert.match(opencodeSource, /ISAGI_HARNESS_METADATA_PATH/);
    assert.match(opencodeSource, /ISAGI_HARNESS_ARTIFACT_DIRECTORY/);
    assert.doesNotMatch(opencodeSource, /ISAGI_HARNESS_JSONL_PATH/);
    assert.doesNotMatch(opencodeSource, /tool\.execute/);
    assert.doesNotMatch(opencodeSource, /ISAGI_HARNESS_EVENT_URL/);

    const claudeSettings = JSON.parse(readFileSync(artifacts.claudeSettingsPath, 'utf8'));
    assert.equal(claudeSettings.hooks.UserPromptSubmit[0].hooks[0].type, 'command');
    assert.match(
      claudeSettings.hooks.UserPromptSubmit[0].hooks[0].command,
      /isagi-claude-hook\.mjs/,
    );
    assert.equal(claudeSettings.hooks.UserPromptSubmit[0].hooks[0].timeout, 2);
    assert.equal(claudeSettings.hooks.Notification[0].matcher, 'idle_prompt');
    assert.match(claudeSettings.hooks.Notification[0].hooks[0].command, /isagi-claude-hook\.mjs/);
    assert.match(claudeSettings.hooks.Stop[0].hooks[0].command, /isagi-claude-hook\.mjs/);
    assert.match(claudeSettings.hooks.StopFailure[0].hooks[0].command, /isagi-claude-hook\.mjs/);
    assert.equal(claudeSettings.hooks.SessionStart, undefined);
    assert.equal(claudeSettings.hooks.SessionEnd, undefined);
    assert.equal(claudeSettings.permissions, undefined);

    const skillRouter = readFileSync(
      resolve(artifacts.configureIsagiSkill.skillDirectory, 'SKILL.md'),
      'utf8',
    );
    assert.match(skillRouter, /name: configure-isagi/);
    assert.match(skillRouter, /metadata:\n  version: "0\.0\.1"/);
    assert.match(skillRouter, /references\/config-global\.md/);
    assert.match(skillRouter, /references\/workflow-style\.md/);
    assert.doesNotMatch(skillRouter, /compatibility:/);
    assert.doesNotMatch(skillRouter, /allowed-tools:/);

    const claudeSkillRouter = readFileSync(
      resolve(
        artifacts.configureIsagiSkill.claudeSkillWorkspaceDirectory,
        '.claude',
        'skills',
        'configure-isagi',
        'SKILL.md',
      ),
      'utf8',
    );
    assert.equal(claudeSkillRouter, skillRouter);

    const globalConfigReference = readFileSync(
      resolve(artifacts.configureIsagiSkill.skillDirectory, 'references', 'config-global.md'),
      'utf8',
    );
    assert.match(globalConfigReference, /runtimeConfigSchema/);
    assert.match(
      globalConfigReference,
      new RegExp(dataRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );

    const projectConfigReference = readFileSync(
      resolve(artifacts.configureIsagiSkill.skillDirectory, 'references', 'config-project.md'),
      'utf8',
    );
    assert.match(projectConfigReference, /projectConfigSchema/);

    const workflowReference = readFileSync(
      resolve(artifacts.configureIsagiSkill.skillDirectory, 'references', 'workflows.md'),
      'utf8',
    );
    assert.match(workflowReference, /ISAGI_RUNTIME_URL/);
    assert.match(workflowReference, /<workflow-key>/);

    const workflowStyleReference = readFileSync(
      resolve(artifacts.configureIsagiSkill.skillDirectory, 'references', 'workflow-style.md'),
      'utf8',
    );
    assert.doesNotMatch(workflowStyleReference, /^## Contents$/m);

    const sdkReference = readFileSync(
      resolve(artifacts.configureIsagiSkill.skillDirectory, 'references', 'sdk', 'index.ts'),
      'utf8',
    );
    assert.match(sdkReference, /defineWorkflow/);

    const claudeHook = readFileSync(artifacts.claudeHookPath, 'utf8');
    assert.match(claudeHook, /session_id/);
    assert.match(claudeHook, /hook_event_name/);
    assert.doesNotMatch(claudeHook, /last_assistant_message/);
    assert.doesNotMatch(claudeHook, /prompt/);
    assert.match(claudeHook, /appendHarnessEvent/);
    assert.match(claudeHook, /harness: "claude"/);
    assert.match(claudeHook, /ISAGI_HARNESS_METADATA_PATH/);
    assert.match(claudeHook, /ISAGI_HARNESS_ARTIFACT_DIRECTORY/);
    assert.doesNotMatch(claudeHook, /ISAGI_HARNESS_JSONL_PATH/);
    assert.doesNotMatch(claudeHook, /ISAGI_HARNESS_EVENT_URL/);

    const codexHook = readFileSync(artifacts.codexHookPath, 'utf8');
    assert.match(codexHook, /session_id/);
    assert.match(codexHook, /hook_event_name/);
    assert.doesNotMatch(codexHook, /last_assistant_message/);
    assert.doesNotMatch(codexHook, /prompt/);
    assert.match(codexHook, /appendHarnessEvent/);
    assert.match(codexHook, /harness: "codex"/);
    assert.match(codexHook, /ISAGI_HARNESS_METADATA_PATH/);
    assert.match(codexHook, /ISAGI_HARNESS_ARTIFACT_DIRECTORY/);
    assert.doesNotMatch(codexHook, /ISAGI_HARNESS_JSONL_PATH/);
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

test('isagi configure skill regeneration removes stale files', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-skill-clean-'));
  try {
    const staleCanonical = resolve(
      dataRoot,
      'skills',
      'shared',
      'configure-isagi',
      'references',
      'old.md',
    );
    const staleClaude = resolve(
      dataRoot,
      'harness-integrations',
      'claude',
      'skill-workspace',
      '.claude',
      'skills',
      'configure-isagi',
      'references',
      'old.md',
    );
    mkdirSync(resolve(staleCanonical, '..'), { recursive: true });
    mkdirSync(resolve(staleClaude, '..'), { recursive: true });
    writeFileSync(staleCanonical, 'stale', 'utf8');
    writeFileSync(staleClaude, 'stale', 'utf8');

    await Effect.runPromise(prepareHarnessIntegrationArtifacts(dataRoot));
    const firstRouter = readFileSync(
      resolve(dataRoot, 'skills', 'shared', 'configure-isagi', 'SKILL.md'),
      'utf8',
    );
    await Effect.runPromise(prepareHarnessIntegrationArtifacts(dataRoot));
    const secondRouter = readFileSync(
      resolve(dataRoot, 'skills', 'shared', 'configure-isagi', 'SKILL.md'),
      'utf8',
    );

    assert.equal(firstRouter, secondRouter);
    assert.throws(() => readFileSync(staleCanonical, 'utf8'), /ENOENT/);
    assert.throws(() => readFileSync(staleClaude, 'utf8'), /ENOENT/);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
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
        skillScanDirectory: '/runtime/skills/shared',
        artifacts: fakeArtifacts(dataRoot),
        runtimeUrl,
      },
    ),
  );

  assert.equal(launch.command, 'opencode');
  assert.deepEqual(launch.args, []);
  assert.equal(launch.cwd, '/repo/isagi');
  assert.equal(launch.launchMode, 'user_shell');

  const env = (await Effect.runPromise(
    launch.envForProcess?.({ ptyProcessId: 20 }) ?? Effect.succeed({}),
  )) as NodeJS.ProcessEnv;
  assert.equal(env.ISAGI_AGENT_SESSION_ID, '10');
  assert.equal(env.ISAGI_RUNTIME_URL, runtimeUrl);
  assert.equal(env.ISAGI_PTY_PROCESS_ID, '20');
  assert.match(env.ISAGI_HARNESS_METADATA_PATH ?? '', /harness\.json$/);
  assert.match(env.ISAGI_HARNESS_ARTIFACT_DIRECTORY ?? '', /agent-sessions\/10$/);
  assert.equal(env.ISAGI_HARNESS_JSONL_PATH, undefined);
  assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}'), {
    plugin: ['file:///runtime/harness-integrations/opencode/isagi-session-plugin.js'],
    skills: {
      paths: ['/runtime/skills/shared'],
    },
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
        skillScanDirectory: '/runtime/skills/shared',
        artifacts: fakeArtifacts('/runtime'),
        runtimeUrl,
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
        skillWorkspaceDirectory: '/runtime/harness-integrations/claude/skill-workspace',
        artifacts: fakeArtifacts('/runtime'),
        runtimeUrl,
      },
    ),
  );

  assert.equal(launch.command, 'claude');
  assert.deepEqual(launch.args, [
    '--resume',
    'claude-session-123',
    '--add-dir',
    '/runtime/harness-integrations/claude/skill-workspace',
    '--settings',
    '/runtime/harness-integrations/claude/settings.json',
  ]);
  assert.equal(launch.args.includes('--session-id'), false);
  assert.equal(launch.cwd, '/repo/isagi');
  assert.equal(launch.launchMode, 'user_shell');

  const env = await Effect.runPromise(
    launch.envForProcess?.({ ptyProcessId: 20 }) ?? Effect.succeed({}),
  );
  assert.equal(env.ISAGI_AGENT_SESSION_ID, '10');
  assert.equal(env.ISAGI_RUNTIME_URL, runtimeUrl);
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
        runtimeUrl,
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
  assert.equal(launch.launchMode, 'user_shell');

  const env = await Effect.runPromise(
    launch.envForProcess?.({ ptyProcessId: 20 }) ?? Effect.succeed({}),
  );
  assert.equal(env.ISAGI_AGENT_SESSION_ID, '10');
  assert.equal(env.ISAGI_RUNTIME_URL, runtimeUrl);
  assert.equal(env.ISAGI_PTY_PROCESS_ID, '20');
  assert.match(env.ISAGI_HARNESS_METADATA_PATH ?? '', /harness\.json$/);
});

test('Codex adapter applies per-invocation model and reasoning effort to interactive launch', async () => {
  const launch = await Effect.runPromise(
    buildCodexLaunch(
      {
        agentSessionId: 10,
        harness: 'codex',
        cwd: '/repo/isagi',
        latestHarnessSessionId: null,
        model: 'gpt-5.5',
        effort: 'medium',
      },
      {
        hookPath: '/runtime/harness-integrations/codex/isagi-codex-hook.mjs',
        artifacts: fakeArtifacts('/runtime'),
        runtimeUrl,
      },
    ),
  );

  assert.equal(launch.command, 'codex');
  assert.equal(launch.args.includes('--model'), true);
  assert.equal(launch.args.includes('gpt-5.5'), true);
  assert.deepEqual(launch.args.slice(-4), [
    '--model',
    'gpt-5.5',
    '-c',
    'model_reasoning_effort="medium"',
  ]);
  assert.equal(launch.cwd, '/repo/isagi');
});

test('Pi adapter applies per-invocation model and reasoning effort to interactive launch', async () => {
  const launch = await Effect.runPromise(
    buildPiLaunch(
      {
        agentSessionId: 10,
        harness: 'pi',
        cwd: '/repo/isagi',
        latestHarnessSessionId: null,
        model: 'sonnet',
        effort: 'high',
      },
      {
        extensionPath: '/runtime/harness-integrations/pi/extension.mjs',
        skillDirectory: '/runtime/skills/shared/configure-isagi',
        artifacts: fakeArtifacts('/runtime'),
        runtimeUrl,
      },
    ),
  );

  assert.equal(launch.command, 'pi');
  assert.deepEqual(launch.args, [
    '--model',
    'sonnet',
    '--thinking',
    'high',
    '--skill',
    '/runtime/skills/shared/configure-isagi',
    '-e',
    '/runtime/harness-integrations/pi/extension.mjs',
  ]);
});

test('Claude adapter applies per-invocation model and reasoning effort to interactive launch', async () => {
  const launch = await Effect.runPromise(
    buildClaudeLaunch(
      {
        agentSessionId: 10,
        harness: 'claude',
        cwd: '/repo/isagi',
        latestHarnessSessionId: null,
        model: 'sonnet',
        effort: 'medium',
      },
      {
        settingsPath: '/runtime/harness-integrations/claude/settings.json',
        skillWorkspaceDirectory: '/runtime/harness-integrations/claude/skill-workspace',
        artifacts: fakeArtifacts('/runtime'),
        runtimeUrl,
      },
    ),
  );

  assert.equal(launch.command, 'claude');
  assert.deepEqual(launch.args, [
    '--model',
    'sonnet',
    '--effort',
    'medium',
    '--add-dir',
    '/runtime/harness-integrations/claude/skill-workspace',
    '--settings',
    '/runtime/harness-integrations/claude/settings.json',
  ]);
});

test('OpenCode adapter applies per-invocation model and reasoning effort to interactive launch', async () => {
  const launch = await Effect.runPromise(
    buildOpenCodeLaunch(
      {
        agentSessionId: 10,
        harness: 'opencode',
        cwd: '/repo/isagi',
        latestHarnessSessionId: 'opencode-session-123',
        model: 'sonnet',
        effort: 'high',
      },
      {
        pluginPath: '/runtime/harness-integrations/opencode/plugin.mjs',
        skillScanDirectory: '/runtime/skills/shared',
        artifacts: fakeArtifacts('/runtime'),
        runtimeUrl,
      },
    ),
  );

  assert.equal(launch.command, 'opencode');
  assert.deepEqual(launch.args, [
    '--session',
    'opencode-session-123',
    '--model',
    'sonnet',
    '--variant',
    'high',
  ]);
});

test('headless harness adapters build non-interactive launch envelopes', async () => {
  const pi = await Effect.runPromise(
    buildPiHeadlessLaunch({
      harness: 'pi',
      cwd: '/repo/isagi',
      prompt: 'judge this',
      model: 'sonnet',
      effort: 'high',
    }),
  );
  assert.equal(pi.command, 'pi');
  assert.deepEqual(pi.args, [
    '--print',
    '--mode',
    'json',
    '--no-session',
    '--model',
    'sonnet',
    '--thinking',
    'high',
    'judge this',
  ]);
  assert.equal(pi.cwd, '/repo/isagi');
  assert.equal(pi.launchMode, 'user_shell');

  const claude = await Effect.runPromise(
    buildClaudeHeadlessLaunch({
      harness: 'claude',
      cwd: '/repo/isagi',
      prompt: 'judge this',
      model: 'sonnet',
      effort: 'medium',
    }),
  );
  assert.equal(claude.command, 'claude');
  assert.deepEqual(claude.args, [
    '--print',
    '--output-format',
    'json',
    '--model',
    'sonnet',
    '--effort',
    'medium',
    'judge this',
  ]);
  assert.equal(claude.cwd, '/repo/isagi');
  assert.equal(claude.launchMode, 'user_shell');

  const codex = await Effect.runPromise(
    buildCodexHeadlessLaunch({
      harness: 'codex',
      cwd: '/repo/isagi',
      prompt: 'judge this',
      model: 'gpt-5.4',
      effort: 'high',
    }),
  );
  assert.equal(codex.command, 'codex');
  assert.equal(codex.args.includes('exec'), true);
  assert.equal(codex.args.includes('--json'), true);
  assert.deepEqual(codex.args.slice(-7), [
    '-C',
    '/repo/isagi',
    '--model',
    'gpt-5.4',
    '-c',
    'model_reasoning_effort="high"',
    'judge this',
  ]);
  assert.equal(codex.cwd, '/repo/isagi');
  assert.equal(codex.launchMode, 'user_shell');

  const opencode = await Effect.runPromise(
    buildOpenCodeHeadlessLaunch({
      harness: 'opencode',
      cwd: '/repo/isagi',
      prompt: 'judge this',
      model: 'anthropic/claude-sonnet-4-6',
      effort: 'high',
    }),
  );
  assert.equal(opencode.command, 'opencode');
  assert.deepEqual(opencode.args, [
    'run',
    '--format',
    'json',
    '--dir',
    '/repo/isagi',
    '--model',
    'anthropic/claude-sonnet-4-6',
    '--variant',
    'high',
    'judge this',
  ]);
  assert.equal(opencode.cwd, '/repo/isagi');
  assert.equal(opencode.launchMode, 'user_shell');
});

function fakeArtifacts(root: string): AgentSessionArtifactsService {
  return {
    paths: (input) => {
      const directory = resolve(root, 'sessions', 'agent-sessions', String(input.agentSessionId));
      return {
        directory,
        metadataPath: resolve(directory, 'harness.json'),
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
    readJsonlForAgentSession: () => Effect.succeed([]),
    listAgentSessionIds: Effect.succeed([]),
    writeHarnessSessionId: () => Effect.void,
    removeDirectory: () => Effect.void,
  } satisfies AgentSessionArtifactsService;
}
