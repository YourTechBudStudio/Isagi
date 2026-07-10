import { resolve } from 'node:path';

import type { HarnessDefinition } from '../definition-types.js';
import { resolveDocsTarget } from '../docs-targets.js';
import { extractPiHeadlessOutput, piHeadlessSemanticError } from '../headless-output.js';
import { reducePiLifecycle } from '../lifecycle.js';
import { buildPiHeadlessLaunch, buildPiLaunch } from './adapter.js';
import { piExtensionSource } from './artifacts.js';
import { readPiConversation } from './conversation.js';

export const piHarnessDefinition = {
  id: 'pi',
  displayName: 'Pi',
  executable: 'pi',
  probe: { command: 'pi', args: ['--version'] },
  docs: {
    kind: 'skill',
    invocation: '/skill:isagi-docs',
    nativePolicy: 'skill_frontmatter',
    implicitInvocationPolicy: 'disabled',
    resolveTarget: (environment) =>
      resolveDocsTarget({
        harness: 'pi',
        environment,
        configuredRoot: 'PI_CODING_AGENT_DIR',
        defaultSegments: ['.pi', 'agent'],
        targetSegments: ['skills', 'isagi-docs'],
      }),
  },
  launch: {
    interactive: (input, dependencies) =>
      buildPiLaunch(input, {
        extensionPath: resolve(dependencies.dataRoot, 'harness-integrations/pi/isagi-session.ts'),
        skillDirectory: dependencies.configureIsagiSkill.skillDirectory,
        artifacts: dependencies.artifacts,
      }),
    headless: buildPiHeadlessLaunch,
    extractHeadlessOutput: extractPiHeadlessOutput,
    semanticHeadlessError: piHeadlessSemanticError,
  },
  lifecycle: {
    reduce: ({ records }) => reducePiLifecycle(records),
    openingRecordedAt: ({ records }, seq) =>
      records.find((record) => record.seq === seq)?.recordedAt ?? null,
  },
  conversation: { read: readPiConversation },
  observation: {
    runtimeArtifacts: (dataRoot) => [
      {
        path: resolve(dataRoot, 'harness-integrations/pi/isagi-session.ts'),
        content: piExtensionSource(),
      },
    ],
  },
} satisfies HarnessDefinition;
