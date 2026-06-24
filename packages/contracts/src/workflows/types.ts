import { Schema } from 'effect';

import { workflowInputKinds } from '@isagi/workflow-sdk';
import type { WorkflowQuestionOption, WorkflowQuestionSpec } from '@isagi/workflow-sdk';

export const workflowInputKindSchema = Schema.Literal(...workflowInputKinds);

export const workflowQuestionOptionSchema: Schema.Schema<WorkflowQuestionOption> = Schema.Struct({
  value: Schema.String,
  label: Schema.optional(Schema.String),
  hint: Schema.optional(Schema.String),
});

export const workflowQuestionSpecSchema: Schema.Schema<WorkflowQuestionSpec> = Schema.Union(
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
);

export type WorkflowInputKind = typeof workflowInputKindSchema.Type;
export type WorkflowQuestionOptionDto = typeof workflowQuestionOptionSchema.Type;
export type WorkflowQuestionSpecDto = typeof workflowQuestionSpecSchema.Type;
