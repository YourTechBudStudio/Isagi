import { createHash } from 'node:crypto';

import { defaultCompactionThreshold } from '@yourtechbudstudio/fluidcast-presets';
import { Cause, Schema } from 'effect';

import {
  appearanceSettingsDefaults,
  terminalSettingsDefaults,
  type AgentHarness,
  type AppearanceSettings,
  type TerminalSettings,
} from '@isagi/contracts';

import { normalizeAbsoluteHomePath } from '../platform/fs/index.js';
import {
  runtimeAppearanceSettingsSchema,
  runtimeConfigPtyBackendSchema,
  runtimeFluidcastSchema,
  runtimeHarnessPolicySchema,
  runtimeTerminalSettingsSchema,
  runtimeWorkflowSettingsSchema,
  type RuntimeConfigPtyBackend,
} from './config-schema.js';
import { issuePaths, joinIssuePath } from './issue-paths.js';

export interface RuntimeHarnessPolicyEntry {
  readonly enabled: boolean;
  readonly installIsagiDocs: boolean;
}
export type RuntimeHarnessPolicy = Readonly<Record<AgentHarness, RuntimeHarnessPolicyEntry>>;
export interface RuntimeHarnessPolicyState {
  readonly status: 'missing' | 'valid' | 'invalid';
  readonly onboardingComplete: boolean;
  readonly policy: RuntimeHarnessPolicy;
  readonly revision: string;
  readonly diagnostic: string | null;
}
type FluidcastSection = typeof runtimeFluidcastSchema.Type;
/** The decoded `fluidcast` section with its defaults applied. Keys stay `Redacted`. */
export type FluidcastConfig = Omit<FluidcastSection, 'speech' | 'preset' | 'history'> & {
  readonly speech: FluidcastSection['speech'] & { readonly format: 'opus' | 'mp3' | 'wav' };
  readonly preset: FluidcastSection['preset'] & { readonly profile: 'compact' | 'detailed' };
  /** Present only when the config has `history.compaction`. */
  readonly history?: {
    readonly compaction: { readonly enabled: boolean; readonly aboveInputTokens: number };
  };
};
/** A language-model connection: the voice's `languageModel` or the `summaryModel`. */
export type FluidcastConnection =
  | FluidcastSection['languageModel']
  | NonNullable<FluidcastSection['summaryModel']>;
export type FluidcastConfigState =
  | { readonly status: 'disabled' }
  | { readonly status: 'ready'; readonly config: FluidcastConfig }
  | { readonly status: 'invalid'; readonly issuePaths: ReadonlyArray<string> };
export interface RuntimeConfigShape {
  readonly pty: { readonly backend: RuntimeConfigPtyBackend };
  readonly harnesses: RuntimeHarnessPolicyState;
  readonly workflows: { readonly additionalDirectories: readonly string[] };
  readonly terminal: TerminalSettings;
  readonly appearance: AppearanceSettings;
  readonly fluidcast: FluidcastConfigState;
}

/**
 * A section that fails startup or a mutation, reduced to where it failed. Thrown by
 * `parseRuntimeConfig` instead of the decode error, whose message can echo a configured value.
 */
export class RuntimeConfigIssues extends Error {
  readonly issuePaths: ReadonlyArray<string>;
  constructor(paths: ReadonlyArray<string>) {
    super(`config.yaml is invalid at ${paths.join(', ')}`);
    this.issuePaths = paths;
  }
}

export const disabledHarnessPolicy: RuntimeHarnessPolicy = {
  pi: { enabled: false, installIsagiDocs: false },
  opencode: { enabled: false, installIsagiDocs: false },
  claude: { enabled: false, installIsagiDocs: false },
  codex: { enabled: false, installIsagiDocs: false },
};
export const defaultRuntimeConfig: RuntimeConfigShape = {
  pty: { backend: 'node-pty' },
  harnesses: policyState('missing', disabledHarnessPolicy),
  workflows: { additionalDirectories: [] },
  terminal: terminalSettingsDefaults,
  appearance: appearanceSettingsDefaults,
  fluidcast: { status: 'disabled' },
};

/** Throws `RuntimeConfigIssues` for a section that must fail; `harnesses` and `fluidcast` never do. */
export function parseRuntimeConfig(value: unknown): RuntimeConfigShape {
  const pty = parsePty(value);
  const workflows = parseWorkflows(value);
  const terminal = parseTerminal(value);
  const appearance = parseAppearance(value);
  const fluidcast = parseFluidcast(value);
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'harnesses'))
    return {
      pty,
      harnesses: policyState('missing', disabledHarnessPolicy),
      workflows,
      terminal,
      appearance,
      fluidcast,
    };
  const decoded = Schema.decodeUnknownExit(runtimeHarnessPolicySchema)(value.harnesses);
  if (decoded._tag === 'Success') {
    const entries = decoded.value;
    const policy = Object.fromEntries(
      (['pi', 'opencode', 'claude', 'codex'] as const).map((id) => {
        const entry = entries[id];
        const enabled = entry?.enabled === true;
        return [id, { enabled, installIsagiDocs: enabled && entry?.installIsagiDocs === true }];
      }),
    ) as unknown as RuntimeHarnessPolicy;
    return {
      pty,
      harnesses: policyState('valid', policy),
      workflows,
      terminal,
      appearance,
      fluidcast,
    };
  }
  return {
    pty,
    harnesses: {
      ...policyState('invalid', disabledHarnessPolicy),
      diagnostic: `invalid harness policy at ${schemaIssuePaths(decoded.cause).join(', ')}`,
    },
    workflows,
    terminal,
    appearance,
    fluidcast,
  };
}

/**
 * The `fluidcast` section. A missing or not-enabled section is `disabled` and is not validated; an
 * invalid enabled one is `invalid` with issue paths. It never throws, so it cannot fail startup or a
 * harness-policy write.
 */
export function parseFluidcast(value: unknown): FluidcastConfigState {
  if (!isRecord(value) || !isRecord(value.fluidcast) || value.fluidcast.enabled !== true)
    return { status: 'disabled' };
  const decoded = Schema.decodeUnknownExit(runtimeFluidcastSchema)(value.fluidcast);
  if (decoded._tag === 'Failure')
    return { status: 'invalid', issuePaths: schemaIssuePaths(decoded.cause, ['fluidcast']) };
  const { history, ...section } = decoded.value;
  const compaction = history?.compaction;
  return {
    status: 'ready',
    config: {
      ...section,
      speech: { ...section.speech, format: section.speech.format ?? 'opus' },
      preset: { ...section.preset, profile: section.preset.profile ?? 'detailed' },
      ...(compaction === undefined
        ? {}
        : {
            history: {
              compaction: {
                enabled: compaction.enabled ?? false,
                aboveInputTokens: compaction.aboveInputTokens ?? defaultCompactionThreshold,
              },
            },
          }),
    },
  };
}

function parseTerminal(value: unknown): TerminalSettings {
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'terminal')) {
    return terminalSettingsDefaults;
  }
  const decoded = decodeSection(runtimeTerminalSettingsSchema, value.terminal, ['terminal']);
  return {
    scrollbackLines: decoded.scrollbackLines ?? terminalSettingsDefaults.scrollbackLines,
    cache: {
      idleTtlMinutes:
        decoded.cache?.idleTtlMinutes ?? terminalSettingsDefaults.cache.idleTtlMinutes,
      maxHiddenSessions:
        decoded.cache?.maxHiddenSessions ?? terminalSettingsDefaults.cache.maxHiddenSessions,
      maxEstimatedBufferMiB:
        decoded.cache?.maxEstimatedBufferMiB ??
        terminalSettingsDefaults.cache.maxEstimatedBufferMiB,
    },
  };
}

function parseAppearance(value: unknown): AppearanceSettings {
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'appearance')) {
    return appearanceSettingsDefaults;
  }
  const decoded = decodeSection(runtimeAppearanceSettingsSchema, value.appearance, ['appearance']);
  return { theme: decoded.theme ?? appearanceSettingsDefaults.theme };
}

function parseWorkflows(value: unknown): RuntimeConfigShape['workflows'] {
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'workflows')) {
    return { additionalDirectories: [] };
  }
  const decoded = decodeSection(runtimeWorkflowSettingsSchema, value.workflows, ['workflows']);
  return {
    additionalDirectories: (decoded.additionalDirectories ?? []).map((directory, index) => {
      try {
        return normalizeAbsoluteHomePath(directory);
      } catch {
        // The error message quotes the configured path; only its location is kept.
        throw new RuntimeConfigIssues([
          joinIssuePath(['workflows', 'additionalDirectories', index]),
        ]);
      }
    }),
  };
}

export function harnessPolicyRevision(
  status: RuntimeHarnessPolicyState['status'],
  policy: RuntimeHarnessPolicy,
) {
  return createHash('sha256')
    .update(JSON.stringify({ presence: status, policy }))
    .digest('hex');
}

function policyState(
  status: RuntimeHarnessPolicyState['status'],
  policy: RuntimeHarnessPolicy,
): RuntimeHarnessPolicyState {
  return {
    status,
    onboardingComplete: status === 'valid',
    policy,
    revision: harnessPolicyRevision(status, policy),
    diagnostic: null,
  };
}

function parsePty(value: unknown): RuntimeConfigShape['pty'] {
  if (!isRecord(value) || !isRecord(value.pty) || value.pty.backend == null)
    return { backend: 'node-pty' };
  return {
    backend: decodeSection(runtimeConfigPtyBackendSchema, value.pty.backend, ['pty', 'backend']),
  };
}

function decodeSection<S extends Schema.Decoder<unknown>>(
  schema: S,
  value: unknown,
  path: ReadonlyArray<string>,
): S['Type'] {
  const decoded = Schema.decodeUnknownExit(schema)(value);
  if (decoded._tag === 'Success') return decoded.value;
  throw new RuntimeConfigIssues(schemaIssuePaths(decoded.cause, path));
}

/** Issue paths from a decode failure's `SchemaError`; a defect in the decoder dies loudly. */
function schemaIssuePaths(
  cause: Cause.Cause<Schema.SchemaError>,
  path: ReadonlyArray<string> = [],
): ReadonlyArray<string> {
  const error = Cause.findErrorOption(cause);
  if (error._tag === 'None') throw Cause.squash(cause);
  return issuePaths(error.value, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
