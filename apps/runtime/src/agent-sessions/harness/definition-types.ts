import type { Effect } from 'effect';

import type { AgentHarness, WorkflowOperationUsage } from '@isagi/contracts';

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
  readonly resolveTarget: (environment: ApprovedHostEnvironment) => HarnessDocsTargetResolution;
  readonly resolveLegacyTargets: (
    environment: ApprovedHostEnvironment,
  ) => readonly HarnessDocsTargetResolution[];
}

export interface HarnessProbeDefinition {
  readonly command: string;
  readonly args: readonly string[];
}

export interface HarnessDefinitionDependencies {
  readonly dataRoot: string;
  readonly artifacts: AgentSessionArtifactsService;
}

export interface HarnessTurnReference {
  readonly harnessSessionId: string;
  readonly seq: number;
  readonly startedAt: string;
}

export interface HarnessConversationTurn extends HarnessTurnReference {
  readonly completedAt: string;
}

export interface HarnessConversationInput {
  readonly turn?: HarnessConversationTurn | undefined;
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
  readonly prompt: {
    readonly renderSkillToken: (name: string) => string;
    readonly renderCommandToken: (name: string) => string;
  };
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
    /**
     * The native session id and usage this provider reported, read out of its finished output.
     *
     * Optional, and a harness that omits it is recorded as knowing nothing rather than as reporting
     * zero. Pure by design: it interprets bytes the caller already holds, so settlement does not
     * acquire IO.
     */
    readonly extractHeadlessProvenance?:
      | ((raw: string) => {
          readonly harnessSessionId: string | null;
          readonly usage: WorkflowOperationUsage | null;
        })
      | undefined;
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
    /**
     * Where this harness's native transcript for a past session would be, and whether it is there.
     *
     * Deliberately separate from `locateNativeSources`, which needs the observer's live in-memory
     * streams — exactly what is gone once a session has been collected. This one takes only facts
     * the runtime recorded durably, so it can answer long after the session ended.
     *
     * `available` is one `stat` at read time rather than a stored flag, keeping ADR 0007's posture
     * that native artifacts are best-effort external sources: a path that was constructed but never
     * written, or a transcript the provider has since rotated, reads as `false` instead of looking
     * live. `null` means no locator could be built at all.
     */
    readonly locateTranscript?:
      | ((input: {
          readonly harnessSessionId: string;
          readonly cwd: string;
        }) => Effect.Effect<{ readonly locator: string; readonly available: boolean } | null>)
      | undefined;
  };
}
