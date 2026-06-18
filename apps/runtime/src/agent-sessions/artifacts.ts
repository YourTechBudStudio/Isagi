import {
  closeSync,
  type Dirent,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { Context, Data, Effect, Layer } from 'effect';

import type { AgentHarness } from '@isagi/contracts';

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

export interface AgentSessionHarnessJsonlRecord {
  readonly schemaVersion: 1;
  readonly recordedAt: string;
  readonly agentSessionId: number;
  readonly ptyProcessId: number;
  readonly harness: AgentHarness;
  readonly nativeEvent: string;
  readonly event: unknown;
}

export interface AgentSessionHarnessJsonlRead {
  readonly path: string;
  readonly records: readonly AgentSessionHarnessJsonlRecord[];
  readonly ignoredLineCount: number;
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
  readonly code:
    | 'metadata_init_failed'
    | 'metadata_write_failed'
    | 'jsonl_init_failed'
    | 'jsonl_read_failed'
    | 'artifact_cleanup_failed';
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
  readonly prepareProcessArtifacts: (input: {
    readonly agentSessionId: number;
    readonly ptyProcessId: number;
  }) => Effect.Effect<AgentSessionArtifactPaths, AgentSessionArtifactError>;
  readonly readMetadata: (agentSessionId: number) => Effect.Effect<AgentSessionHarnessMetadataRead>;
  readonly readJsonl: (input: {
    readonly agentSessionId: number;
    readonly ptyProcessId: number;
  }) => Effect.Effect<AgentSessionHarnessJsonlRead, AgentSessionArtifactError>;
  readonly readJsonlForAgentSession: (
    agentSessionId: number,
  ) => Effect.Effect<readonly AgentSessionHarnessJsonlRead[], AgentSessionArtifactError>;
  readonly listAgentSessionIds: Effect.Effect<readonly number[]>;
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
      prepareProcessArtifacts: (input) =>
        Effect.try({
          try: () => {
            const paths = artifactPaths(root, input);
            mkdirSync(paths.directory, { recursive: true });
            if (paths.jsonlPath) {
              closeSync(openSync(paths.jsonlPath, 'a'));
            }
            return paths;
          },
          catch: (cause) =>
            new AgentSessionArtifactError({
              code: 'jsonl_init_failed',
              agentSessionId: input.agentSessionId,
              path: artifactPaths(root, input).jsonlPath ?? artifactPaths(root, input).directory,
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
      readJsonl: (input) =>
        Effect.try({
          try: () => {
            const paths = artifactPaths(root, input);
            if (!paths.jsonlPath)
              return { path: paths.directory, records: [], ignoredLineCount: 0 };
            return parseJsonl(paths.jsonlPath, readFileSync(paths.jsonlPath, 'utf8'));
          },
          catch: (cause) => {
            const paths = artifactPaths(root, input);
            if (isMissingFileError(cause) && paths.jsonlPath) {
              return new AgentSessionArtifactError({
                code: 'jsonl_read_failed',
                agentSessionId: input.agentSessionId,
                path: paths.jsonlPath,
                cause,
              });
            }
            return new AgentSessionArtifactError({
              code: 'jsonl_read_failed',
              agentSessionId: input.agentSessionId,
              path: paths.jsonlPath ?? paths.directory,
              cause,
            });
          },
        }).pipe(
          Effect.catchTag('AgentSessionArtifactError', (error) =>
            isMissingFileError(error.cause)
              ? Effect.succeed({ path: error.path, records: [], ignoredLineCount: 0 })
              : Effect.fail(error),
          ),
        ),
      readJsonlForAgentSession: (agentSessionId) =>
        Effect.try({
          try: () => {
            const paths = artifactPaths(root, { agentSessionId });
            let entries: Dirent[];
            try {
              entries = readdirSync(paths.directory, { withFileTypes: true });
            } catch (error) {
              if (isMissingFileError(error)) return [];
              throw error;
            }
            return entries
              .filter((entry) => entry.isFile())
              .map((entry) => ptyProcessIdFromJsonlFileName(entry.name))
              .filter((ptyProcessId): ptyProcessId is number => ptyProcessId !== null)
              .map((ptyProcessId) => {
                const filePath = artifactPaths(root, { agentSessionId, ptyProcessId }).jsonlPath;
                if (!filePath) return null;
                return parseJsonl(filePath, readFileSync(filePath, 'utf8'));
              })
              .filter((read): read is AgentSessionHarnessJsonlRead => read !== null);
          },
          catch: (error) =>
            new AgentSessionArtifactError({
              code: 'jsonl_read_failed',
              agentSessionId,
              path: artifactPaths(root, { agentSessionId }).directory,
              cause: error,
            }),
        }),
      listAgentSessionIds: Effect.sync(() => {
        try {
          return readdirSync(root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => Number(entry.name))
            .filter((id) => Number.isSafeInteger(id) && id > 0);
        } catch (error) {
          if (isMissingFileError(error)) return [];
          throw error;
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

export function parseJsonl(path: string, raw: string): AgentSessionHarnessJsonlRead {
  const records: AgentSessionHarnessJsonlRecord[] = [];
  let ignoredLineCount = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = parseJsonlRecord(line);
      if (record) records.push(record);
      else ignoredLineCount += 1;
    } catch {
      ignoredLineCount += 1;
    }
  }
  return { path, records, ignoredLineCount };
}

function parseJsonlRecord(line: string): AgentSessionHarnessJsonlRecord | null {
  const parsed = JSON.parse(line) as unknown;
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== 1) return null;
  if (typeof record.recordedAt !== 'string' || !record.recordedAt) return null;
  if (!isPositiveInteger(record.agentSessionId)) return null;
  if (!isPositiveInteger(record.ptyProcessId)) return null;
  if (!isAgentHarness(record.harness)) return null;
  if (typeof record.nativeEvent !== 'string' || !record.nativeEvent) return null;
  if (!('event' in record)) return null;
  return {
    schemaVersion: 1,
    recordedAt: record.recordedAt,
    agentSessionId: record.agentSessionId,
    ptyProcessId: record.ptyProcessId,
    harness: record.harness,
    nativeEvent: record.nativeEvent,
    event: record.event,
  };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isAgentHarness(value: unknown): value is AgentHarness {
  return value === 'pi' || value === 'opencode' || value === 'claude' || value === 'codex';
}

function ptyProcessIdFromJsonlFileName(fileName: string) {
  const match = /^([1-9]\d*)\.harness\.jsonl$/.exec(fileName);
  if (!match?.[1]) return null;
  const ptyProcessId = Number(match[1]);
  return Number.isSafeInteger(ptyProcessId) ? ptyProcessId : null;
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
