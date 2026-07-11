import { Schema } from 'effect';

import { agentHarnessSchema } from '../surfaces/types.js';

export const harnessPolicyEntrySchema = Schema.Struct({
  enabled: Schema.Boolean,
  installIsagiDocs: Schema.Boolean,
});
export const harnessPolicySchema = Schema.Struct({
  pi: harnessPolicyEntrySchema,
  opencode: harnessPolicyEntrySchema,
  claude: harnessPolicyEntrySchema,
  codex: harnessPolicyEntrySchema,
});
export const executableAvailabilitySchema = Schema.Literal(
  'available',
  'missing',
  'incompatible',
  'probe_failed',
);
export const docsReconciliationActionSchema = Schema.Literal(
  'installed',
  'replaced',
  'unchanged',
  'untouched',
  'failed',
  'unsupported',
);
export const docsReconciliationReasonSchema = Schema.Literal(
  'not_requested',
  'environment_capture_failed',
  'target_resolution_failed',
  'explicit_invocation_unsupported',
  'transaction_evidence',
  'publication_failed',
  'rollback_failed',
);
export const harnessControlPlaneEntrySchema = Schema.Struct({
  harness: agentHarnessSchema,
  availability: Schema.Literal('pending', 'available', 'missing', 'incompatible', 'probe_failed'),
  policy: harnessPolicyEntrySchema,
});
export const docsHarnessResultSchema = Schema.Struct({
  harness: agentHarnessSchema,
  availability: Schema.Literal('available', 'missing', 'incompatible', 'probe_failed'),
  action: docsReconciliationActionSchema,
  reason: Schema.NullOr(docsReconciliationReasonSchema),
  destination: Schema.NullOr(Schema.String),
  diagnostic: Schema.NullOr(Schema.String),
});
export const docsReconciliationResultSchema = Schema.Struct({
  outcome: Schema.Literal('succeeded', 'partially_failed', 'failed'),
  policyRevision: Schema.String,
  inventoryGeneration: Schema.Number.pipe(Schema.int(), Schema.positive()),
  fingerprint: Schema.String,
  results: Schema.Array(docsHarnessResultSchema),
});
export const reconciliationStatusSchema = Schema.Struct({
  desiredFingerprint: Schema.NullOr(Schema.String),
  runningFingerprint: Schema.NullOr(Schema.String),
  lastCompletedFingerprint: Schema.NullOr(Schema.String),
  lastAppliedFingerprint: Schema.NullOr(Schema.String),
  lastResult: Schema.NullOr(docsReconciliationResultSchema),
});
export const controlPlaneSnapshotSchema = Schema.Struct({
  onboardingComplete: Schema.Boolean,
  configStatus: Schema.Literal('missing', 'valid', 'invalid'),
  configDiagnostic: Schema.NullOr(Schema.String),
  policyRevision: Schema.String,
  inventory: Schema.Union(
    Schema.Struct({ status: Schema.Literal('pending') }),
    Schema.Struct({
      status: Schema.Literal('ready'),
      generation: Schema.Number.pipe(Schema.int(), Schema.positive()),
      environment: Schema.Literal('trusted', 'probe_failed'),
      node: executableAvailabilitySchema,
      packageManagers: Schema.Record({
        key: Schema.Literal('pnpm', 'npm', 'bun'),
        value: executableAvailabilitySchema,
      }),
    }),
  ),
  harnesses: Schema.Array(harnessControlPlaneEntrySchema),
  reconciliation: reconciliationStatusSchema,
});
export const acceptHarnessPolicyInputSchema = Schema.Struct({
  expectedPolicyRevision: Schema.String,
  policy: harnessPolicySchema,
});
export const refreshInventoryOutputSchema = Schema.Struct({
  generation: Schema.Number.pipe(Schema.int(), Schema.positive()),
});
export const acceptHarnessPolicyOutputSchema = Schema.Struct({
  acceptedPolicyRevision: Schema.String,
  reconciledPolicyRevision: Schema.String,
  inventoryGeneration: Schema.Number.pipe(Schema.int(), Schema.positive()),
  disposition: Schema.Literal('applied', 'superseded'),
  reconciliation: docsReconciliationResultSchema,
});
export type HarnessPolicy = Schema.Schema.Type<typeof harnessPolicySchema>;
export type ControlPlaneSnapshot = Schema.Schema.Type<typeof controlPlaneSnapshotSchema>;
export type DocsReconciliationResult = Schema.Schema.Type<typeof docsReconciliationResultSchema>;
