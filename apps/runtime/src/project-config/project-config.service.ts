import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Data, Effect } from 'effect';
import { parse } from 'yaml';

import { hashWorktreeHooks } from './project-config.hash.js';
import {
  normalizeWorktreeHooksConfig,
  summarizeWorktreeHooks,
  type WorktreeHooksConfig,
} from './project-config.schema.js';

export class ProjectConfigError extends Data.TaggedError('ProjectConfigError')<{
  readonly code: 'setup_config_invalid';
  readonly message: string;
  readonly path: string;
  readonly projectId?: number | undefined;
  readonly cause?: unknown;
}> {}

export type LoadedWorktreeHooks =
  | { readonly status: 'not_configured' }
  | {
      readonly status: 'configured';
      readonly config: WorktreeHooksConfig;
      readonly hash: string;
      readonly summary: ReturnType<typeof summarizeWorktreeHooks>;
    };

export function loadWorktreeHooks(input: {
  readonly projectId?: number | undefined;
  readonly rootPath: string;
}): Effect.Effect<LoadedWorktreeHooks, ProjectConfigError> {
  const configPath = join(input.rootPath, '.isagi', 'config.yaml');
  return Effect.gen(function* () {
    const exists = yield* pathExists(configPath);
    if (!exists) {
      return { status: 'not_configured' as const };
    }

    const contents = yield* Effect.tryPromise({
      try: () => readFile(configPath, 'utf8'),
      catch: (cause) =>
        new ProjectConfigError({
          code: 'setup_config_invalid',
          message: `Could not read project config at ${configPath}.`,
          path: configPath,
          projectId: input.projectId,
          cause,
        }),
    });

    const parsed = yield* Effect.try({
      try: () => parse(contents),
      catch: (cause) =>
        new ProjectConfigError({
          code: 'setup_config_invalid',
          message: `Could not parse project config at ${configPath}.`,
          path: configPath,
          projectId: input.projectId,
          cause,
        }),
    });

    const config = yield* Effect.try({
      try: () => normalizeWorktreeHooksConfig(parsed),
      catch: (cause) =>
        new ProjectConfigError({
          code: 'setup_config_invalid',
          message: cause instanceof Error ? cause.message : `Invalid worktree hooks config.`,
          path: configPath,
          projectId: input.projectId,
          cause,
        }),
    });

    if (!config || config.postCreate.length === 0) {
      return { status: 'not_configured' as const };
    }

    return {
      status: 'configured' as const,
      config,
      hash: hashWorktreeHooks(config),
      summary: summarizeWorktreeHooks(config),
    };
  });
}

function pathExists(path: string) {
  return Effect.promise(() =>
    access(path).then(
      () => true,
      () => false,
    ),
  );
}
