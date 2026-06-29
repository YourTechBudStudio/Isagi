import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Data, Effect } from 'effect';
import { build } from 'esbuild';

import type { WorkflowDefinition } from './types.js';

export class WorkflowLoadError extends Data.TaggedError('WorkflowLoadError')<{
  readonly message: string;
  readonly workflowKey: string;
  readonly cause?: unknown;
}> {}

const workflowArtifactBuilds = new Map<string, Promise<void>>();

export function loadWorkflowDefinition(input: {
  readonly workflowKey: string;
  readonly indexPath: string;
  readonly artifactPath: string;
}) {
  return Effect.tryPromise({
    try: async () => {
      await ensureWorkflowArtifact(input);
      const loaded = (await import(pathToFileURL(input.artifactPath).href)) as {
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

async function ensureWorkflowArtifact(input: {
  readonly indexPath: string;
  readonly artifactPath: string;
}) {
  if (existsSync(input.artifactPath)) return;
  const inFlight = workflowArtifactBuilds.get(input.artifactPath);
  if (inFlight) return inFlight;

  const buildPromise = buildWorkflowArtifact(input).finally(() => {
    workflowArtifactBuilds.delete(input.artifactPath);
  });
  workflowArtifactBuilds.set(input.artifactPath, buildPromise);
  return buildPromise;
}

async function buildWorkflowArtifact(input: {
  readonly indexPath: string;
  readonly artifactPath: string;
}) {
  mkdirSync(dirname(input.artifactPath), { recursive: true });
  await build({
    entryPoints: [input.indexPath],
    outfile: input.artifactPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    logLevel: 'silent',
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
