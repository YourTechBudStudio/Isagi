import { pathToFileURL } from 'node:url';

import { Data, Effect } from 'effect';
import { tsImport } from 'tsx/esm/api';

import type { WorkflowDefinition } from './types.js';

export class WorkflowLoadError extends Data.TaggedError('WorkflowLoadError')<{
  readonly message: string;
  readonly workflowKey: string;
  readonly cause?: unknown;
}> {}

export function loadWorkflowDefinition(input: {
  readonly workflowKey: string;
  readonly indexPath: string;
}) {
  return Effect.tryPromise({
    try: async () => {
      const loaded = (await tsImport(input.indexPath, pathToFileURL(import.meta.url).href)) as {
        readonly default?: unknown;
      };
      return workflowDefinitionFromDefault(input.workflowKey, loaded.default);
    },
    catch: (cause) =>
      new WorkflowLoadError({
        workflowKey: input.workflowKey,
        message: `Failed to load workflow ${input.workflowKey}: ${errorMessage(cause)}`,
        cause,
      }),
  });
}

function workflowDefinitionFromDefault(
  workflowKey: string,
  value: unknown,
): WorkflowDefinition<unknown> {
  if (!value || typeof value !== 'object') {
    throw new Error('default export must be a workflow definition object.');
  }
  const definition = value as Partial<Record<keyof WorkflowDefinition<unknown>, unknown>>;
  const missing = ['command', 'validate', 'init', 'step'].filter(
    (field) => typeof definition[field as keyof WorkflowDefinition<unknown>] !== 'function',
  );
  if (missing.length > 0) {
    throw new Error(`workflow definition is missing function field(s): ${missing.join(', ')}.`);
  }
  return definition as WorkflowDefinition<unknown>;
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
