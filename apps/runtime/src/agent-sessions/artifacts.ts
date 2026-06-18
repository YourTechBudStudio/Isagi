import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Context, Data, Effect, Layer } from 'effect';

import { DataDirectory } from '../persistence/index.js';

export interface AgentSessionArtifactPaths {
  readonly directory: string;
  readonly metadataPath: string;
  readonly jsonlPath: string | null;
}

export interface AgentSessionHarnessMetadata {
  readonly schemaVersion: 1;
  readonly harnessSessionId: string | null;
  readonly updatedAt: string;
}

export type AgentSessionHarnessMetadataRead =
  | {
      readonly status: 'valid';
      readonly metadata: AgentSessionHarnessMetadata;
      readonly metadataPath: string;
    }
  | {
      readonly status: 'missing';
      readonly metadataPath: string;
    }
  | {
      readonly status: 'invalid';
      readonly metadataPath: string;
      readonly diagnostic: string;
    };

export class AgentSessionArtifactError extends Data.TaggedError('AgentSessionArtifactError')<{
  readonly code: 'metadata_init_failed' | 'metadata_write_failed' | 'artifact_cleanup_failed';
  readonly agentSessionId: number;
  readonly path: string;
  readonly cause: unknown;
}> {}

export interface AgentSessionArtifactsService {
  readonly paths: (input: {
    readonly agentSessionId: number;
    readonly ptyProcessId?: number | null | undefined;
  }) => AgentSessionArtifactPaths;
  readonly initializeMetadata: (
    agentSessionId: number,
  ) => Effect.Effect<void, AgentSessionArtifactError>;
  readonly readMetadata: (agentSessionId: number) => Effect.Effect<AgentSessionHarnessMetadataRead>;
  readonly writeHarnessSessionId: (input: {
    readonly agentSessionId: number;
    readonly harnessSessionId: string;
  }) => Effect.Effect<void, AgentSessionArtifactError>;
  readonly removeDirectory: (
    agentSessionId: number,
  ) => Effect.Effect<void, AgentSessionArtifactError>;
}

export const AgentSessionArtifacts = Context.GenericTag<AgentSessionArtifactsService>(
  'isagi/AgentSessionArtifacts',
);

export const AgentSessionArtifactsLive = Layer.effect(
  AgentSessionArtifacts,
  Effect.gen(function* () {
    const directory = yield* DataDirectory;
    const root = join(directory.paths.sessionsPath, 'agent-sessions');

    const service = {
      paths: (input) => artifactPaths(root, input),
      initializeMetadata: (agentSessionId) =>
        Effect.try({
          try: () => {
            const paths = artifactPaths(root, { agentSessionId });
            mkdirSync(paths.directory, { recursive: true });
            writeFileSync(paths.metadataPath, `${JSON.stringify(initialMetadata(), null, 2)}\n`);
          },
          catch: (cause) =>
            new AgentSessionArtifactError({
              code: 'metadata_init_failed',
              agentSessionId,
              path: artifactPaths(root, { agentSessionId }).metadataPath,
              cause,
            }),
        }),
      readMetadata: (agentSessionId) =>
        Effect.sync(() => {
          const paths = artifactPaths(root, { agentSessionId });
          try {
            return {
              status: 'valid',
              metadata: parseMetadata(readFileSync(paths.metadataPath, 'utf8')),
              metadataPath: paths.metadataPath,
            } satisfies AgentSessionHarnessMetadataRead;
          } catch (error) {
            if (isMissingFileError(error))
              return {
                status: 'missing',
                metadataPath: paths.metadataPath,
              } satisfies AgentSessionHarnessMetadataRead;
            return {
              status: 'invalid',
              metadataPath: paths.metadataPath,
              diagnostic: diagnosticForInvalidMetadata(error),
            } satisfies AgentSessionHarnessMetadataRead;
          }
        }),
      writeHarnessSessionId: (input) =>
        Effect.try({
          try: () => {
            const paths = artifactPaths(root, { agentSessionId: input.agentSessionId });
            mkdirSync(paths.directory, { recursive: true });
            writeFileSync(
              paths.metadataPath,
              `${JSON.stringify(
                {
                  schemaVersion: 1,
                  harnessSessionId: input.harnessSessionId,
                  updatedAt: new Date().toISOString(),
                } satisfies AgentSessionHarnessMetadata,
                null,
                2,
              )}\n`,
            );
          },
          catch: (cause) =>
            new AgentSessionArtifactError({
              code: 'metadata_write_failed',
              agentSessionId: input.agentSessionId,
              path: artifactPaths(root, { agentSessionId: input.agentSessionId }).metadataPath,
              cause,
            }),
        }),
      removeDirectory: (agentSessionId) =>
        Effect.try({
          try: () => {
            rmSync(artifactPaths(root, { agentSessionId }).directory, {
              recursive: true,
              force: true,
            });
          },
          catch: (cause) =>
            new AgentSessionArtifactError({
              code: 'artifact_cleanup_failed',
              agentSessionId,
              path: artifactPaths(root, { agentSessionId }).directory,
              cause,
            }),
        }),
    } satisfies AgentSessionArtifactsService;

    return service;
  }),
);

function artifactPaths(
  root: string,
  input: { readonly agentSessionId: number; readonly ptyProcessId?: number | null | undefined },
): AgentSessionArtifactPaths {
  const directory = join(root, String(input.agentSessionId));
  return {
    directory,
    metadataPath: join(directory, 'harness.json'),
    jsonlPath: input.ptyProcessId ? join(directory, `${input.ptyProcessId}.harness.jsonl`) : null,
  };
}

function initialMetadata(): AgentSessionHarnessMetadata {
  return {
    schemaVersion: 1,
    harnessSessionId: null,
    updatedAt: new Date().toISOString(),
  };
}

function parseMetadata(raw: string): AgentSessionHarnessMetadata {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object') throw new Error('Metadata must be an object.');
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== 1) throw new Error('Unsupported metadata schema version.');
  if (
    record.harnessSessionId !== null &&
    (typeof record.harnessSessionId !== 'string' || record.harnessSessionId.length === 0)
  ) {
    throw new Error('Invalid harnessSessionId.');
  }
  if (typeof record.updatedAt !== 'string' || !record.updatedAt) {
    throw new Error('Invalid updatedAt.');
  }
  return {
    schemaVersion: 1,
    harnessSessionId: record.harnessSessionId,
    updatedAt: record.updatedAt,
  };
}

function isMissingFileError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  );
}

function diagnosticForInvalidMetadata(error: unknown) {
  return error instanceof Error && error.message
    ? `Invalid harness metadata: ${error.message}`
    : 'Invalid harness metadata.';
}
