import { resolve } from 'node:path';

import { Effect } from 'effect';

import type { HarnessDefinition } from '../definition-types.js';
import { resolveDocsTarget } from '../docs-targets.js';
import { extractCodexHeadlessOutput } from '../headless-output.js';
import { buildCodexHeadlessLaunch, buildCodexLaunch } from './adapter.js';
import { codexHookSource } from './artifacts.js';
import { readCodexConversation } from './conversation.js';
import { reduceCodexRolloutLifecycle } from './lifecycle.js';
import { hookCodexRolloutPaths, locateCodexRolloutPaths } from './native-artifacts.js';

export const codexHarnessDefinition = {
  id: 'codex',
  displayName: 'Codex',
  executable: 'codex',
  probe: { command: 'codex', args: ['--version'] },
  docs: {
    resolveTarget: (environment) =>
      resolveDocsTarget({
        harness: 'codex',
        environment,
        configuredRoot: 'CODEX_HOME',
        defaultSegments: ['.codex'],
        targetSegments: ['skills', 'isagi-docs'],
      }),
    resolveLegacyTargets: () => [],
  },
  prompt: {
    renderSkillToken: (name) => `$${name}`,
    renderCommandToken: (name) => `$${name}`,
  },
  launch: {
    interactive: (input, dependencies) =>
      buildCodexLaunch(input, {
        hookPath: resolve(dependencies.dataRoot, 'harness-integrations/codex/isagi-codex-hook.mjs'),
        artifacts: dependencies.artifacts,
      }),
    headless: buildCodexHeadlessLaunch,
    extractHeadlessOutput: extractCodexHeadlessOutput,
  },
  lifecycle: {
    reduce: ({ codexRecords }) => reduceCodexRolloutLifecycle(codexRecords ?? []),
    openingRecordedAt: ({ codexRecords }, seq) =>
      codexRecords.find((record) => record.seq === seq)?.recordedAt ?? null,
  },
  conversation: { read: readCodexConversation },
  observation: {
    runtimeArtifacts: (dataRoot) => [
      {
        path: resolve(dataRoot, 'harness-integrations/codex/isagi-codex-hook.mjs'),
        content: codexHookSource(),
      },
    ],
    locateNativeSources: (input) =>
      Effect.gen(function* () {
        return [
          ...hookCodexRolloutPaths(input.streams),
          ...(yield* locateCodexRolloutPaths({
            agentSessionId: input.agentSessionId,
            harnessSessionId: input.harnessSessionId,
            discovery: input.discovery,
          })),
        ];
      }),
  },
} satisfies HarnessDefinition;
