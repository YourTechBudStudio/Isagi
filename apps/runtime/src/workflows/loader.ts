import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Data, Effect } from 'effect';
import { build, type BuildOptions } from 'esbuild';

import type { WorkflowDefinition } from './types.js';

export class WorkflowLoadError extends Data.TaggedError('WorkflowLoadError')<{
  readonly stage: 'compile' | 'load' | 'shape';
  readonly message: string;
  readonly workflowKey: string;
  readonly cause?: unknown;
}> {}

const workflowArtifactBuilds = new Map<string, Promise<void>>();

export function loadWorkflowDefinition(input: {
  readonly workflowKey: string;
  readonly indexPath: string;
  readonly artifactPath: string;
  readonly compileMode: WorkflowCompileMode;
  readonly workflowSdkPackageRoot?: string | undefined;
}) {
  return Effect.tryPromise({
    try: async () => {
      try {
        await ensureWorkflowArtifact(input);
      } catch (cause: unknown) {
        throw new WorkflowLoadError({
          stage: 'compile',
          workflowKey: input.workflowKey,
          message: `Failed to compile workflow ${input.workflowKey}: ${errorMessage(cause)}`,
          cause,
        });
      }

      try {
        const loaded = (await import(pathToFileURL(input.artifactPath).href)) as {
          readonly default?: unknown;
        };
        return loaded;
      } catch (cause: unknown) {
        throw new WorkflowLoadError({
          stage: 'load',
          workflowKey: input.workflowKey,
          message: `Failed to import workflow ${input.workflowKey}: ${errorMessage(cause)}`,
          cause,
        });
      }
    },
    catch: (cause) =>
      cause instanceof WorkflowLoadError
        ? cause
        : new WorkflowLoadError({
            stage: 'load',
            workflowKey: input.workflowKey,
            message: `Failed to load workflow ${input.workflowKey}: ${errorMessage(cause)}`,
            cause,
          }),
  }).pipe(
    Effect.flatMap((loaded) =>
      Effect.try({
        try: () => workflowDefinitionFromDefault(input.workflowKey, loaded.default),
        catch: (cause) =>
          new WorkflowLoadError({
            stage: 'shape',
            workflowKey: input.workflowKey,
            message: `Failed to read workflow ${input.workflowKey}: ${errorMessage(cause)}`,
            cause,
          }),
      }),
    ),
  );
}

async function ensureWorkflowArtifact(input: {
  readonly indexPath: string;
  readonly artifactPath: string;
  readonly compileMode: WorkflowCompileMode;
  readonly workflowSdkPackageRoot?: string | undefined;
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
  readonly compileMode: WorkflowCompileMode;
  readonly workflowSdkPackageRoot?: string | undefined;
}) {
  mkdirSync(dirname(input.artifactPath), { recursive: true });
  const options: BuildOptions = {
    entryPoints: [input.indexPath],
    outfile: input.artifactPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'silent',
  };
  if (input.compileMode === 'external') {
    options.packages = 'external';
  } else {
    options.plugins = [workflowSdkResolvePlugin(input.workflowSdkPackageRoot)];
  }
  await build(options);
}

export type WorkflowCompileMode = 'external' | 'bundle-workflow-sdk';

function workflowSdkResolvePlugin(workflowSdkPackageRoot: string | undefined) {
  if (!workflowSdkPackageRoot) {
    throw new Error('workflowSdkPackageRoot is required when bundling the workflow SDK.');
  }
  return {
    name: 'isagi-workflow-sdk-resolver',
    setup(buildApi: import('esbuild').PluginBuild) {
      buildApi.onResolve({ filter: /^@isagi\/workflow-sdk$/ }, () => ({
        path: join(workflowSdkPackageRoot, 'dist', 'index.js'),
      }));
    },
  } satisfies import('esbuild').Plugin;
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
