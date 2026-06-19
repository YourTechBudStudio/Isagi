import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Data, Effect, Either } from 'effect';
import { parse } from 'yaml';

import {
  normalizeCommandCatalogConfig,
  type WorktreeCommandCatalogConfig,
} from './command-config.schema.js';
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

export type LoadedWorktreeCommandCatalog =
  | {
      readonly status: 'configured';
      readonly config: WorktreeCommandCatalogConfig;
      readonly path: string;
    }
  | {
      readonly status: 'config_error';
      readonly diagnostic: {
        readonly code: 'command_config_invalid';
        readonly path: string;
        readonly message: string;
      };
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

export function loadWorktreeCommandCatalog(input: {
  readonly worktreeRootPath: string;
}): Effect.Effect<LoadedWorktreeCommandCatalog> {
  const configPath = join(input.worktreeRootPath, '.isagi', 'config.yaml');
  return Effect.gen(function* () {
    const contents = yield* Effect.tryPromise({
      try: () => readFile(configPath, 'utf8'),
      catch: (cause) =>
        isNodeErrorCode(cause, 'ENOENT')
          ? {
              status: 'configured' as const,
              config: { commands: [] },
              path: configPath,
            }
          : commandConfigDiagnostic(configPath, 'Could not read command config.', cause),
    }).pipe(Effect.either);
    if (Either.isLeft(contents)) {
      return contents.left;
    }

    const parsed = yield* Effect.try({
      try: () => parse(contents.right),
      catch: (cause) =>
        commandConfigDiagnostic(configPath, 'Could not parse command config.', cause),
    }).pipe(Effect.either);
    if (Either.isLeft(parsed)) {
      return parsed.left;
    }

    const config = yield* Effect.try({
      try: () =>
        normalizeCommandCatalogConfig(parsed.right, {
          worktreeRootPath: input.worktreeRootPath,
        }),
      catch: (cause) => commandConfigDiagnostic(configPath, 'Invalid command config.', cause),
    }).pipe(Effect.either);
    if (Either.isLeft(config)) {
      return config.left;
    }

    return {
      status: 'configured' as const,
      config: config.right,
      path: configPath,
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

function commandConfigDiagnostic(path: string, fallback: string, cause: unknown) {
  const detail = cause instanceof Error && cause.message ? cause.message : fallback;
  return {
    status: 'config_error' as const,
    diagnostic: {
      code: 'command_config_invalid' as const,
      path,
      message: detail,
    },
  };
}

function isNodeErrorCode(cause: unknown, code: string) {
  return Boolean(
    cause &&
    typeof cause === 'object' &&
    'code' in cause &&
    (cause as { readonly code?: unknown }).code === code,
  );
}
