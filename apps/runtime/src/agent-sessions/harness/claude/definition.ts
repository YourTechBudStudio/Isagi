import { resolve } from 'node:path';

import type { HarnessDefinition } from '../definition-types.js';
import { resolveDocsTarget } from '../docs-targets.js';
import { extractClaudeHeadlessOutput } from '../headless-output.js';
import { buildClaudeHeadlessLaunch, buildClaudeLaunch } from './adapter.js';
import { claudeHookSource, claudeSettings } from './artifacts.js';
import { readClaudeConversation } from './conversation.js';
import { reduceClaudeLifecycle } from './lifecycle.js';

export const claudeHarnessDefinition = {
  id: 'claude',
  displayName: 'Claude',
  executable: 'claude',
  probe: { command: 'claude', args: ['--version'] },
  docs: {
    explicitInvocationSupported: true,
    kind: 'skill',
    invocation: '/isagi-docs',
    nativePolicy: 'skill_frontmatter',
    implicitInvocationPolicy: 'disabled',
    resolveTarget: (environment) =>
      resolveDocsTarget({
        harness: 'claude',
        environment,
        configuredRoot: 'CLAUDE_CONFIG_DIR',
        defaultSegments: ['.claude'],
        targetSegments: ['skills', 'isagi-docs'],
      }),
  },
  launch: {
    interactive: (input, dependencies) =>
      buildClaudeLaunch(input, {
        settingsPath: resolve(dependencies.dataRoot, 'harness-integrations/claude/settings.json'),
        artifacts: dependencies.artifacts,
      }),
    headless: buildClaudeHeadlessLaunch,
    extractHeadlessOutput: extractClaudeHeadlessOutput,
  },
  lifecycle: {
    reduce: ({ records }) => reduceClaudeLifecycle(records),
    openingRecordedAt: ({ records }, seq) =>
      records.find((record) => record.seq === seq)?.recordedAt ?? null,
  },
  conversation: { read: readClaudeConversation },
  observation: {
    runtimeArtifacts: (dataRoot) => {
      const hookPath = resolve(dataRoot, 'harness-integrations/claude/isagi-claude-hook.mjs');
      return [
        { path: hookPath, content: claudeHookSource() },
        {
          path: resolve(dataRoot, 'harness-integrations/claude/settings.json'),
          content: `${JSON.stringify(claudeSettings({ hookPath }), null, 2)}\n`,
        },
      ];
    },
  },
} satisfies HarnessDefinition;
