import { createHash } from 'node:crypto';

import { Schema } from 'effect';

import type { AgentHarness } from '@isagi/contracts';

import { boundedDiagnostic } from '../lib/diagnostic.js';
import { normalizeAbsoluteHomePath } from '../paths/path.utils.js';
import {
  runtimeConfigPtyBackendSchema,
  runtimeHarnessPolicySchema,
  runtimeWorkflowSettingsSchema,
  type RuntimeConfigPtyBackend,
} from './runtime-config.schema.js';

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
export interface RuntimeConfigShape {
  readonly pty: { readonly backend: RuntimeConfigPtyBackend };
  readonly harnesses: RuntimeHarnessPolicyState;
  readonly workflows: { readonly additionalDirectories: readonly string[] };
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
};

export function parseRuntimeConfig(value: unknown): RuntimeConfigShape {
  const pty = parsePty(value);
  const workflows = parseWorkflows(value);
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'harnesses'))
    return { pty, harnesses: policyState('missing', disabledHarnessPolicy), workflows };
  try {
    const decoded = Schema.decodeUnknownSync(runtimeHarnessPolicySchema)(value.harnesses);
    const policy = Object.fromEntries(
      (['pi', 'opencode', 'claude', 'codex'] as const).map((id) => {
        const entry = decoded[id];
        const enabled = entry?.enabled === true;
        return [id, { enabled, installIsagiDocs: enabled && entry?.installIsagiDocs === true }];
      }),
    ) as unknown as RuntimeHarnessPolicy;
    return { pty, harnesses: policyState('valid', policy), workflows };
  } catch (error) {
    return {
      pty,
      harnesses: {
        ...policyState('invalid', disabledHarnessPolicy),
        diagnostic: boundedDiagnostic(error),
      },
      workflows,
    };
  }
}

function parseWorkflows(value: unknown): RuntimeConfigShape['workflows'] {
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'workflows')) {
    return { additionalDirectories: [] };
  }
  const decoded = Schema.decodeUnknownSync(runtimeWorkflowSettingsSchema)(value.workflows);
  return {
    additionalDirectories: (decoded.additionalDirectories ?? []).map(normalizeAbsoluteHomePath),
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
  return { backend: Schema.decodeUnknownSync(runtimeConfigPtyBackendSchema)(value.pty.backend) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
