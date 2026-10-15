import { resolve } from 'node:path';

import { Effect } from 'effect';

import type { HarnessDefinition } from '../definition-types.js';
import { resolveDocsTarget } from '../docs-targets.js';
import { extractCodexHeadlessOutput } from '../headless-output.js';
import { transcriptAt } from '../transcript-locator.js';
import {
  buildCodexHeadlessLaunch,
  buildCodexLaunch,
  buildCodexSdkInstrumentation,
} from './adapter.js';
import { codexHookSource } from './artifacts.js';
import { readCodexConversation } from './conversation.js';
import { reduceCodexRolloutLifecycle } from './lifecycle.js';
import { hookCodexRolloutPaths, locateCodexRolloutPaths } from './native-artifacts.js';

const codexHookPath = (dataRoot: string) =>
  resolve(dataRoot, 'harness-integrations/codex/isagi-codex-hook.mjs');

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
        hookPath: codexHookPath(dependencies.dataRoot),
        artifacts: dependencies.artifacts,
      }),
    sdk: (input, dependencies) =>
      buildCodexSdkInstrumentation(input, {
        hookPath: codexHookPath(dependencies.dataRoot),
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
        path: codexHookPath(dataRoot),
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
    /**
     * Codex's transcript path is *looked up* in its rollout index rather than constructed, so a
     * missing index entry means no locator can be built at all — `null`, not a path that is merely
     * unavailable. `index_only` discovery keeps this a bounded read: a read-time provenance lookup
     * must not walk the rollout tree.
     */
    locateTranscript: ({ harnessSessionId }) =>
      Effect.gen(function* () {
        const paths = yield* locateCodexRolloutPaths({
          // No agent session is in hand at read time, and none is invented: the lookup omits the
          // field from its diagnostics rather than logging a stand-in id.
          agentSessionId: null,
          harnessSessionId,
          discovery: 'index_only',
        });
        const first = paths[0];
        return first ? yield* transcriptAt(first.path) : null;
      }),
  },
} satisfies HarnessDefinition;
