import {
  constants,
  chmodSync,
  closeSync,
  fstatSync,
  lstatSync,
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

import { DataDirectory } from '../../persistence/index.js';

export interface AgentSessionArtifactPaths {
  readonly directory: string;
  readonly metadataPath: string;
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
  readonly harnessSessionId: string;
  readonly ptyProcessId: number | null;
  readonly harness: AgentHarness;
  readonly nativeEvent: string;
  readonly event: unknown;
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
    | 'artifact_permissions_insecure'
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
    try {
      ensureSecureArtifactDirectory(root);
    } catch {
      console.warn(
        '[runtime] Harness artifact root could not be secured; observation will degrade.',
      );
    }

    const service = {
      paths: (input) => artifactPaths(root, input),
      initializeMetadata: (agentSessionId) =>
        Effect.try({
          try: () => {
            const paths = artifactPaths(root, { agentSessionId });
            ensureSecureArtifactDirectory(root);
            ensureSecureArtifactDirectory(paths.directory);
            writeSecureArtifactFile(
              paths.metadataPath,
              `${JSON.stringify(initialMetadata(), null, 2)}\n`,
            );
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
            ensureSecureArtifactDirectory(root);
            ensureSecureArtifactDirectory(paths.directory);
            return paths;
          },
          catch: (cause) =>
            new AgentSessionArtifactError({
              code: 'jsonl_init_failed',
              agentSessionId: input.agentSessionId,
              path: artifactPaths(root, input).directory,
              cause,
            }),
        }),
      readMetadata: (agentSessionId) =>
        Effect.sync(() => {
          const paths = artifactPaths(root, { agentSessionId });
          try {
            assertSecureArtifactPath(paths.directory, 'directory');
            assertSecureArtifactPath(paths.metadataPath, 'file');
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
      listAgentSessionIds: Effect.sync(() => {
        try {
          assertSecureArtifactPath(root, 'directory');
          return readdirSync(root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => Number(entry.name))
            .filter((id) => Number.isSafeInteger(id) && id > 0);
        } catch (error) {
          if (isMissingFileError(error)) return [];
          console.warn('[runtime] Harness artifact inventory is unavailable', {
            root,
            error,
          });
          return [];
        }
      }),
      writeHarnessSessionId: (input) =>
        Effect.try({
          try: () => {
            const paths = artifactPaths(root, { agentSessionId: input.agentSessionId });
            ensureSecureArtifactDirectory(root);
            ensureSecureArtifactDirectory(paths.directory);
            writeSecureArtifactFile(
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
  input: { readonly agentSessionId: number },
): AgentSessionArtifactPaths {
  const directory = join(root, String(input.agentSessionId));
  return {
    directory,
    metadataPath: join(directory, 'harness.json'),
  };
}

function ensureSecureArtifactDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Harness artifact directory is not a real directory.');
  }
  if (process.platform === 'win32') return;
  // `mkdir` leaves an existing directory's mode untouched, so every write path
  // deliberately re-applies the sensitive-artifact policy.
  chmodSync(path, 0o700);
  const secured = lstatSync(path);
  if ((secured.mode & 0o777) !== 0o700) {
    throw new Error('Harness artifact directory permissions are insecure.');
  }
}

function assertSecureArtifactPath(path: string, kind: 'directory' | 'file') {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error(`Harness artifact path is not a regular ${kind}.`);
  }
}

function writeSecureArtifactFile(path: string, content: string) {
  try {
    assertSecureArtifactPath(path, 'file');
    if (process.platform !== 'win32') chmodSync(path, 0o600);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
  if (process.platform !== 'win32' && !constants.O_NOFOLLOW) {
    throw new Error('Secure no-follow file writes are unavailable.');
  }
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_TRUNC |
      (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
    0o600,
  );
  try {
    if (!fstatSync(fd).isFile()) throw new Error('Harness artifact is not a regular file.');
    writeFileSync(fd, content, 'utf8');
    if (process.platform === 'win32') return;
    chmodSync(path, 0o600);
    if ((lstatSync(path).mode & 0o777) !== 0o600) {
      throw new Error('Harness artifact permissions are insecure.');
    }
  } finally {
    // `writeFileSync` does not own a caller-provided descriptor.
    closeSync(fd);
  }
}

export function parseJsonlRecord(line: string): AgentSessionHarnessJsonlRecord | null {
  const parsed = JSON.parse(line) as unknown;
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== 1) return null;
  if (typeof record.recordedAt !== 'string' || !record.recordedAt) return null;
  if (!isPositiveInteger(record.agentSessionId)) return null;
  if (typeof record.harnessSessionId !== 'string' || !record.harnessSessionId) return null;
  if (
    record.ptyProcessId !== undefined &&
    record.ptyProcessId !== null &&
    !isPositiveInteger(record.ptyProcessId)
  ) {
    return null;
  }
  if (!isAgentHarness(record.harness)) return null;
  if (typeof record.nativeEvent !== 'string' || !record.nativeEvent) return null;
  if (!('event' in record)) return null;
  return {
    schemaVersion: 1,
    recordedAt: record.recordedAt,
    agentSessionId: record.agentSessionId,
    harnessSessionId: record.harnessSessionId,
    ptyProcessId: record.ptyProcessId ?? null,
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
