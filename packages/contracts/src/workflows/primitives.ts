import { workflowInputKinds, workflowWaitKinds } from '@yourtechbudstudio/isagi-workflow-sdk';
import type {
  WorkflowCommandManifest,
  WorkflowPlacementRequest,
  WorkflowQuestionOption,
  WorkflowQuestionSpec,
  WorkflowSurfaceChoice,
  WorkflowUiFeedback,
  WorkflowWorktreeChoice,
} from '@yourtechbudstudio/isagi-workflow-sdk';
import { Schema } from 'effect';

import { nonEmptyString, positiveInteger } from '../scalars.js';

/** Shared value shapes for the workflow wire surface. */

export const workflowInputKindSchema = Schema.Literals(workflowInputKinds);
export const workflowWaitKindSchema = Schema.Literals(workflowWaitKinds);

export const workflowQuestionOptionSchema: Schema.Codec<WorkflowQuestionOption> = Schema.Struct({
  value: Schema.String,
  label: Schema.optional(Schema.String),
  hint: Schema.optional(Schema.String),
});

export const workflowQuestionSpecSchema: Schema.Codec<WorkflowQuestionSpec> = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('text'),
    key: Schema.String,
    label: Schema.String,
    placeholder: Schema.optional(Schema.String),
    default: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal('select'),
    key: Schema.String,
    label: Schema.String,
    options: Schema.Array(workflowQuestionOptionSchema),
    default: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal('multi-select'),
    key: Schema.String,
    label: Schema.String,
    options: Schema.Array(workflowQuestionOptionSchema),
    default: Schema.optional(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    kind: Schema.Literal('confirm'),
    key: Schema.String,
    label: Schema.String,
    default: Schema.optional(Schema.Boolean),
  }),
]);

export const workflowCommandManifestSchema: Schema.Codec<WorkflowCommandManifest> = Schema.Struct({
  title: nonEmptyString,
  description: Schema.optional(Schema.String),
  inputs: Schema.optional(Schema.Array(workflowQuestionSpecSchema)),
  hidden: Schema.optional(Schema.Boolean),
});

export const workflowUiFeedbackSchema: Schema.Codec<WorkflowUiFeedback> = Schema.Struct({
  kind: Schema.optional(Schema.Literals(['info', 'warning', 'error'])),
  phase: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});

export const workflowLogLevelSchema = Schema.Literals(['debug', 'info', 'warning', 'error']);

export const workflowUserInputAnswersSchema = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Array(Schema.String), Schema.Boolean]),
);

export const workflowInputsSchema = Schema.Record(Schema.String, Schema.Unknown);

/**
 * Which worktree a run was asked to execute in.
 *
 * Annotated against the SDK type rather than merely resembling it: the author hook returns the SDK
 * shape and this schema decodes it, so a drift between the two is a compile error instead of a
 * decode failure at launch.
 */
export const workflowWorktreeChoiceSchema: Schema.Codec<WorkflowWorktreeChoice> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('current') }),
  Schema.Struct({ kind: Schema.Literal('existing'), worktreeId: positiveInteger }),
  Schema.Struct({
    kind: Schema.Literal('create'),
    branch: nonEmptyString,
    fromRef: nonEmptyString,
  }),
]);

/** Which surface a run was asked to attach to. Bound to the SDK type for the same reason. */
export const workflowSurfaceChoiceSchema: Schema.Codec<WorkflowSurfaceChoice> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('current') }),
  Schema.Struct({ kind: Schema.Literal('existing'), surfaceId: positiveInteger }),
  Schema.Struct({ kind: Schema.Literal('create'), title: nonEmptyString }),
]);

/** A requested placement: what was asked for, never what was obtained. */
export const workflowPlacementRequestSchema: Schema.Codec<WorkflowPlacementRequest> = Schema.Struct(
  {
    worktree: workflowWorktreeChoiceSchema,
    surface: workflowSurfaceChoiceSchema,
  },
);

/**
 * Who decided the placement. `override` is a caller supplying `placement` on the launch request,
 * `selector` is the workflow's own `placement` hook, `default` is current/current when neither is
 * present. A caller beats the hook, which beats the default.
 */
export const workflowPlacementSourceSchema = Schema.Literals(['default', 'selector', 'override']);

export const workflowNodeKindSchema = Schema.Literals(['operation', 'subgraph', 'checkpoint']);

export const workflowOutcomeKindSchema = Schema.Literals(['success', 'failure']);

export type WorkflowWorktreeChoiceDto = typeof workflowWorktreeChoiceSchema.Type;
export type WorkflowSurfaceChoiceDto = typeof workflowSurfaceChoiceSchema.Type;
export type WorkflowPlacementRequestDto = typeof workflowPlacementRequestSchema.Type;
export type WorkflowPlacementSource = typeof workflowPlacementSourceSchema.Type;
export type WorkflowNodeKind = typeof workflowNodeKindSchema.Type;
export type WorkflowOutcomeKind = typeof workflowOutcomeKindSchema.Type;
export type WorkflowCommandManifestDto = typeof workflowCommandManifestSchema.Type;
export type WorkflowQuestionOptionDto = typeof workflowQuestionOptionSchema.Type;
export type WorkflowQuestionSpecDto = typeof workflowQuestionSpecSchema.Type;
export type WorkflowUiFeedbackDto = typeof workflowUiFeedbackSchema.Type;
export type WorkflowLogLevelDto = typeof workflowLogLevelSchema.Type;
export type WorkflowInputKind = typeof workflowInputKindSchema.Type;
export type WorkflowWaitKind = typeof workflowWaitKindSchema.Type;
export type WorkflowUserInputAnswers = typeof workflowUserInputAnswersSchema.Type;
