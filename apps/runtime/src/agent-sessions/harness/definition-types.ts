import type { Effect } from 'effect';

import type { AgentHarness } from '@isagi/contracts';

import type { LaunchPtyProcessInput } from '../../pty-processes/types.js';
import type { CodexRolloutLifecycleRecord } from './codex/lifecycle.js';
import type { CodexRolloutPath } from './codex/native-artifacts.js';
import type { AgentSessionArtifactsService } from './ledger.js';
import type { HarnessLifecycleResult } from './lifecycle.js';
import type { HarnessObservationRecord } from './projection.js';
import type {
  ConversationMessage,
  HarnessAdapterError,
  HarnessHeadlessLaunchContext,
  HarnessLaunchContext,
} from './types.js';

export const approvedHostEnvironmentKeys = [
  'HOME',
  'PATH',
  'PI_CODING_AGENT_DIR',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'OPENCODE_CONFIG_DIR',
  'XDG_CONFIG_HOME',
] as const;

export type ApprovedHostEnvironmentKey = (typeof approvedHostEnvironmentKeys)[number];
export type ApprovedHostEnvironment = Readonly<Partial<Record<ApprovedHostEnvironmentKey, string>>>;

export type HarnessDocsTargetResolution =
  | { readonly _tag: 'Resolved'; readonly path: string }
  | {
      readonly _tag: 'MissingEnvironmentRoot';
      readonly harness: AgentHarness;
      readonly required: 'HOME';
    };

export interface HarnessDocsIntegration {
  readonly kind: 'skill' | 'command';
  readonly invocation: string;
  readonly nativePolicy: 'skill_frontmatter' | 'codex_agent_policy' | 'explicit_command';
  readonly implicitInvocationPolicy: 'disabled';
  readonly resolveTarget: (environment: ApprovedHostEnvironment) => HarnessDocsTargetResolution;
}

export interface HarnessProbeDefinition {
  readonly command: string;
  readonly args: readonly string[];
}

export interface HarnessDefinitionDependencies {
  readonly dataRoot: string;
  readonly configureIsagiSkill: {
    readonly skillDirectory: string;
    readonly skillScanDirectory: string;
    readonly claudeSkillWorkspaceDirectory: string;
  };
  readonly artifacts: AgentSessionArtifactsService;
}

export interface HarnessConversationInput {
  readonly agentSessionId: number;
  readonly cwd: string;
  readonly harnessSessionId: string | null;
  readonly streams: readonly [
    harnessSessionId: string,
    records: readonly HarnessObservationRecord[],
  ][];
}

export interface HarnessDefinition {
  readonly id: AgentHarness;
  readonly displayName: string;
  readonly executable: string;
  readonly probe: HarnessProbeDefinition;
  readonly docs: HarnessDocsIntegration;
  readonly launch: {
    readonly interactive: (
      input: HarnessLaunchContext,
      dependencies: HarnessDefinitionDependencies,
    ) => Effect.Effect<LaunchPtyProcessInput, HarnessAdapterError>;
    readonly headless: (
      input: HarnessHeadlessLaunchContext,
    ) => Effect.Effect<LaunchPtyProcessInput, HarnessAdapterError>;
    readonly extractHeadlessOutput: (raw: string) => string;
    readonly semanticHeadlessError?: ((raw: string) => string | null) | undefined;
  };
  readonly lifecycle: {
    readonly reduce: (input: {
      readonly records: readonly HarnessObservationRecord[];
      readonly codexRecords?: readonly CodexRolloutLifecycleRecord[] | undefined;
    }) => HarnessLifecycleResult;
    readonly openingRecordedAt: (
      input: {
        readonly records: readonly HarnessObservationRecord[];
        readonly codexRecords: readonly CodexRolloutLifecycleRecord[];
      },
      seq: number,
    ) => string | null;
  };
  readonly conversation: {
    readonly read: (
      input: HarnessConversationInput,
    ) => Effect.Effect<readonly ConversationMessage[]>;
  };
  readonly observation: {
    readonly runtimeArtifacts: (dataRoot: string) => readonly {
      readonly path: string;
      readonly content: string;
    }[];
    readonly locateNativeSources?:
      | ((input: {
          readonly agentSessionId: number;
          readonly harnessSessionId: string;
          readonly streams: readonly [string, readonly HarnessObservationRecord[]][];
          readonly discovery: 'index_only' | 'full';
        }) => Effect.Effect<readonly CodexRolloutPath[]>)
      | undefined;
  };
}
