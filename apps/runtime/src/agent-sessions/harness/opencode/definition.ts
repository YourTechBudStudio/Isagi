import { resolve } from 'node:path';

import type { HarnessDefinition } from '../definition-types.js';
import { resolveOpenCodeDocsLegacyTarget, resolveOpenCodeDocsTarget } from '../docs-targets.js';
import { extractOpenCodeHeadlessOutput } from '../headless-output.js';
import { buildOpenCodeHeadlessLaunch, buildOpenCodeLaunch } from './adapter.js';
import { opencodePluginSource } from './artifacts.js';
import { readOpenCodeConversation } from './conversation.js';
import { reduceOpenCodeLifecycle } from './lifecycle.js';

export const openCodeHarnessDefinition = {
  id: 'opencode',
  displayName: 'OpenCode',
  executable: 'opencode',
  probe: { command: 'opencode', args: ['--version'] },
  docs: {
    resolveTarget: resolveOpenCodeDocsTarget,
    resolveLegacyTargets: (environment) => [resolveOpenCodeDocsLegacyTarget(environment)],
  },
  prompt: {
    renderSkillToken: (name) => `/${name}`,
    renderCommandToken: (name) => `/${name}`,
  },
  launch: {
    interactive: (input, dependencies) =>
      buildOpenCodeLaunch(input, {
        pluginPath: resolve(
          dependencies.dataRoot,
          'harness-integrations/opencode/isagi-session-plugin.js',
        ),
        artifacts: dependencies.artifacts,
      }),
    headless: buildOpenCodeHeadlessLaunch,
    extractHeadlessOutput: extractOpenCodeHeadlessOutput,
  },
  lifecycle: {
    reduce: ({ records }) => reduceOpenCodeLifecycle(records),
    openingRecordedAt: ({ records }, seq) =>
      records.find((record) => record.seq === seq)?.recordedAt ?? null,
  },
  conversation: { read: readOpenCodeConversation },
  observation: {
    runtimeArtifacts: (dataRoot) => [
      {
        path: resolve(dataRoot, 'harness-integrations/opencode/isagi-session-plugin.js'),
        content: opencodePluginSource(),
      },
    ],
  },
} satisfies HarnessDefinition;
