import { Schema } from 'effect';

import { editorProvisioningStateSchema } from '../editor/types.js';
import { agentHarnessSchema, harnessLaunchBlockReasonSchema } from '../surfaces/types.js';

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
export const executableAvailabilitySchema = Schema.Literals([
  'available',
  'missing',
  'incompatible',
  'probe_failed',
]);
export const docsReconciliationActionSchema = Schema.Literals([
  'installed',
  'replaced',
  'unchanged',
  'untouched',
  'failed',
]);
export const docsReconciliationReasonSchema = Schema.Literals([
  'not_requested',
  'environment_capture_failed',
  'target_resolution_failed',
  'transaction_evidence',
  'publication_failed',
  'rollback_failed',
]);
// Whether the runtime would create a process for this harness right now, and if
// not, why. Availability is kept as a separate fact; this projection folds
// onboarding/config/policy/inventory/availability into the single launchability
// answer the runtime enforces, so the web never re-derives that ladder. It
// carries no diagnostic string — diagnostics stay on the runtime and, for panes,
// on the last socket/claim error.
export const harnessLaunchProjectionSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal('launchable') }),
  Schema.Struct({ status: Schema.Literal('blocked'), reason: harnessLaunchBlockReasonSchema }),
]);
export const harnessControlPlaneEntrySchema = Schema.Struct({
  harness: agentHarnessSchema,
  availability: Schema.Literals([
    'pending',
    'available',
    'missing',
    'incompatible',
    'probe_failed',
  ]),
  policy: harnessPolicyEntrySchema,
  launch: harnessLaunchProjectionSchema,
});
export const docsHarnessResultSchema = Schema.Struct({
  harness: agentHarnessSchema,
  availability: Schema.Literals(['available', 'missing', 'incompatible', 'probe_failed']),
  action: docsReconciliationActionSchema,
  reason: Schema.NullOr(docsReconciliationReasonSchema),
  destination: Schema.NullOr(Schema.String),
  diagnostic: Schema.NullOr(Schema.String),
});
export const docsReconciliationResultSchema = Schema.Struct({
  outcome: Schema.Literals(['succeeded', 'partially_failed', 'failed']),
  policyRevision: Schema.String,
  inventoryGeneration: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
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
  configStatus: Schema.Literals(['missing', 'valid', 'invalid']),
  configDiagnostic: Schema.NullOr(Schema.String),
  policyRevision: Schema.String,
  inventory: Schema.Union([
    Schema.Struct({ status: Schema.Literal('pending') }),
    Schema.Struct({
      status: Schema.Literal('ready'),
      generation: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
      environment: Schema.Literals(['trusted', 'probe_failed']),
    }),
  ]),
  harnesses: Schema.Array(harnessControlPlaneEntrySchema),
  reconciliation: reconciliationStatusSchema,
  editorProvisioning: editorProvisioningStateSchema,
});
export const acceptHarnessPolicyInputSchema = Schema.Struct({
  expectedPolicyRevision: Schema.String,
  policy: harnessPolicySchema,
});
export const refreshInventoryOutputSchema = Schema.Struct({
  generation: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
});
export const acceptHarnessPolicyOutputSchema = Schema.Struct({
  acceptedPolicyRevision: Schema.String,
  reconciledPolicyRevision: Schema.String,
  inventoryGeneration: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  disposition: Schema.Literals(['applied', 'superseded']),
  reconciliation: docsReconciliationResultSchema,
});
export type HarnessPolicy = typeof harnessPolicySchema.Type;
export type HarnessLaunchProjection = typeof harnessLaunchProjectionSchema.Type;
export type HarnessControlPlaneEntry = typeof harnessControlPlaneEntrySchema.Type;
export type ControlPlaneSnapshot = typeof controlPlaneSnapshotSchema.Type;
export type DocsReconciliationResult = typeof docsReconciliationResultSchema.Type;
export type DocsHarnessResult = typeof docsHarnessResultSchema.Type;
export type DocsReconciliationAction = typeof docsReconciliationActionSchema.Type;
export type DocsReconciliationReason = typeof docsReconciliationReasonSchema.Type;
export type AcceptHarnessPolicyInput = typeof acceptHarnessPolicyInputSchema.Type;
export type AcceptHarnessPolicyOutput = typeof acceptHarnessPolicyOutputSchema.Type;
export type RefreshInventoryOutput = typeof refreshInventoryOutputSchema.Type;
