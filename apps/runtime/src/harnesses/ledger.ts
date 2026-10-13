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
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { Context, Data, Effect, Layer, Result, Schema, SchemaIssue } from 'effect';

import type { AgentHarness } from '@isagi/contracts';

import {
  describeOperationalCause,
  describeSafely,
  type SafeDiagnostic,
} from '../platform/diagnostics/index.js';
import {
  DataDirectory,
  emptyOrphanSweepStats,
  isIdName,
  listOrphanCandidates,
  openCollectorRoot,
  sweepOrphans,
  type OrphanSweepStats,
} from '../platform/persistence/index.js';

// Below the data root; the folder writer and the orphan-folder collector share it.
const artifactRootSegments = ['sessions', 'agent-sessions'] as const;

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
  readonly sdkExecutionId: string | null;
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

export class AgentSessionArtifactError
  extends Data.TaggedError('AgentSessionArtifactError')<{
    readonly code:
      | 'metadata_init_failed'
      | 'metadata_write_failed'
      | 'jsonl_init_failed'
      | 'artifact_permissions_insecure';
    readonly agentSessionId: number;
    readonly path: string;
    readonly cause: unknown;
  }>
  implements SafeDiagnostic
{
  // The path is deliberately left out: it is user data, and callers log it as its own field.
  [describeSafely]() {
    return { label: `Harness artifact operation failed (${this.code})`, cause: this.cause };
  }
}

/**
 * Why the artifact policy refused a path it was about to read or write. Each reason keeps the
 * message the policy used to throw, because a refused metadata read persists that message as the
 * session's status reason (`diagnosticForInvalidMetadata`).
 */
const artifactPathRejections = {
  not_real_directory: 'Harness artifact directory is not a real directory.',
  directory_permissions_insecure: 'Harness artifact directory permissions are insecure.',
  not_regular_directory: 'Harness artifact path is not a regular directory.',
  not_regular_file: 'Harness artifact path is not a regular file.',
  opened_not_regular_file: 'Harness artifact is not a regular file.',
  file_permissions_insecure: 'Harness artifact permissions are insecure.',
  nofollow_unavailable: 'Secure no-follow file writes are unavailable.',
} as const;

class HarnessArtifactPathRejected
  extends Data.TaggedError('HarnessArtifactPathRejected')<{
    readonly reason: keyof typeof artifactPathRejections;
  }>
  implements SafeDiagnostic
{
  override get message() {
    return artifactPathRejections[this.reason];
  }

  [describeSafely]() {
    return { label: `Harness artifact path rejected (${this.reason})`, cause: null };
  }
}

function rejectArtifactPath(reason: keyof typeof artifactPathRejections): never {
  throw new HarnessArtifactPathRejected({ reason });
}

const make = Effect.gen(function* () {
  const directory = yield* DataDirectory;
  const root = join(directory.paths.root, ...artifactRootSegments);
  yield* Effect.try(() => ensureSecureArtifactDirectory(root)).pipe(
    Effect.catchTag('UnknownError', (error) =>
      Effect.logWarning(
        'Harness artifact root could not be secured; observation will degrade.',
      ).pipe(Effect.annotateLogs({ root, cause: describeOperationalCause(error.cause) })),
    ),
  );

  const service = AgentSessionArtifacts.of({
    paths: (input) => artifactPaths(root, input),
    initializeMetadata: Effect.fn('AgentSessionArtifacts.initializeMetadata')(
      function* (agentSessionId) {
        const paths = artifactPaths(root, { agentSessionId });
        return yield* Effect.try({
          try: () => {
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
              path: paths.metadataPath,
              cause,
            }),
        });
      },
    ),
    prepareProcessArtifacts: Effect.fn('AgentSessionArtifacts.prepareProcessArtifacts')(
      function* (input) {
        const paths = artifactPaths(root, input);
        return yield* Effect.try({
          try: () => {
            ensureSecureArtifactDirectory(root);
            ensureSecureArtifactDirectory(paths.directory);
            return paths;
          },
          catch: (cause) =>
            new AgentSessionArtifactError({
              code: 'jsonl_init_failed',
              agentSessionId: input.agentSessionId,
              path: paths.directory,
              cause,
            }),
        });
      },
    ),
    // Read on every observer poll of every live agent session, so it is not traced.
    readMetadata: (agentSessionId) =>
      Effect.sync(() => readMetadataFile(artifactPaths(root, { agentSessionId }))),
    listAgentSessionIds: Effect.try({
      try: () => {
        assertSecureArtifactPath(root, 'directory');
        return readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => Number(entry.name))
          .filter((id) => Number.isSafeInteger(id) && id > 0);
      },
      catch: (cause) => cause,
    }).pipe(
      // Inventory is best effort: a missing root is an empty inventory, anything else degrades to one too.
      Effect.catch((error) =>
        isMissingFileError(error)
          ? Effect.succeed([])
          : Effect.logWarning('Harness artifact inventory is unavailable').pipe(
              Effect.annotateLogs({ root, cause: describeOperationalCause(error) }),
              Effect.as([]),
            ),
      ),
    ),
    writeHarnessSessionId: Effect.fn('AgentSessionArtifacts.writeHarnessSessionId')(
      function* (input) {
        const paths = artifactPaths(root, { agentSessionId: input.agentSessionId });
        return yield* Effect.try({
          try: () => {
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
              path: paths.metadataPath,
              cause,
            }),
        });
      },
    ),
    collectOrphanFolders: Effect.fn('AgentSessionArtifacts.collectOrphanFolders')(
      function* (input) {
        const label = 'agent session folder';
        const opened = yield* openCollectorRoot(directory.paths.root, artifactRootSegments, label);
        if (opened.status !== 'ready') return emptyOrphanSweepStats;
        const listing = yield* listOrphanCandidates(opened.directory, 'directory', isIdName, label);
        if (listing.status !== 'listed') return emptyOrphanSweepStats;
        return yield* sweepOrphans({
          label,
          candidates: listing.candidates,
          isLive: (candidate) => input.liveIds.has(Number(candidate.name)),
          minAgeMs: input.minAgeMs,
          nowMs: input.nowMs,
        });
      },
    ),
  });

  return service;
});

export class AgentSessionArtifacts extends Context.Service<
  AgentSessionArtifacts,
  {
    readonly paths: (input: { readonly agentSessionId: number }) => AgentSessionArtifactPaths;
    readonly initializeMetadata: (
      agentSessionId: number,
    ) => Effect.Effect<void, AgentSessionArtifactError>;
    readonly prepareProcessArtifacts: (input: {
      readonly agentSessionId: number;
    }) => Effect.Effect<AgentSessionArtifactPaths, AgentSessionArtifactError>;
    readonly readMetadata: (
      agentSessionId: number,
    ) => Effect.Effect<AgentSessionHarnessMetadataRead>;
    readonly listAgentSessionIds: Effect.Effect<readonly number[]>;
    readonly writeHarnessSessionId: (input: {
      readonly agentSessionId: number;
      readonly harnessSessionId: string;
    }) => Effect.Effect<void, AgentSessionArtifactError>;
    /**
     * Deletes session folders that no `agent_sessions` row references once they are older than
     * `minAgeMs`. Deleting a session removes its row only; this collector reclaims the folder later.
     */
    readonly collectOrphanFolders: (input: {
      readonly liveIds: ReadonlySet<number>;
      readonly minAgeMs: number;
      readonly nowMs: number;
    }) => Effect.Effect<OrphanSweepStats>;
  }
>()('isagi/runtime/harnesses/AgentSessionArtifacts') {
  static readonly layer = Layer.effect(AgentSessionArtifacts, make);
}

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
    rejectArtifactPath('not_real_directory');
  }
  if (process.platform === 'win32') return;
  // `mkdir` leaves an existing directory's mode untouched, so every write path
  // deliberately re-applies the sensitive-artifact policy.
  chmodSync(path, 0o700);
  const secured = lstatSync(path);
  if ((secured.mode & 0o777) !== 0o700) {
    rejectArtifactPath('directory_permissions_insecure');
  }
}

function assertSecureArtifactPath(path: string, kind: 'directory' | 'file') {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) {
    rejectArtifactPath(kind === 'directory' ? 'not_regular_directory' : 'not_regular_file');
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
    rejectArtifactPath('nofollow_unavailable');
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
    if (!fstatSync(fd).isFile()) rejectArtifactPath('opened_not_regular_file');
    writeFileSync(fd, content, 'utf8');
    if (process.platform === 'win32') return;
    chmodSync(path, 0o600);
    if ((lstatSync(path).mode & 0o777) !== 0o600) {
      rejectArtifactPath('file_permissions_insecure');
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
  const sdkExecutionId = optionalNonEmptyString(record.sdkExecutionId);
  if (sdkExecutionId === undefined) return null;
  if (!isAgentHarness(record.harness)) return null;
  if (typeof record.nativeEvent !== 'string' || !record.nativeEvent) return null;
  if (!('event' in record)) return null;
  return {
    schemaVersion: 1,
    recordedAt: record.recordedAt,
    agentSessionId: record.agentSessionId,
    harnessSessionId: record.harnessSessionId,
    ptyProcessId: record.ptyProcessId ?? null,
    sdkExecutionId,
    harness: record.harness,
    nativeEvent: record.nativeEvent,
    event: record.event,
  };
}

/** Missing or `null` reads as `null`; anything but a non-empty string is invalid (`undefined`). */
function optionalNonEmptyString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' && value ? value : undefined;
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

/**
 * `harness.json`. Unknown keys are accepted and dropped; `harnessSessionId` is required and is
 * `null` until the harness reports a session.
 */
const harnessMetadataSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  harnessSessionId: Schema.NullOr(Schema.NonEmptyString),
  updatedAt: Schema.NonEmptyString,
});

const formatMetadataIssue = SchemaIssue.makeFormatterStandardSchemaV1();

function readMetadataFile(paths: AgentSessionArtifactPaths): AgentSessionHarnessMetadataRead {
  let raw: string;
  try {
    assertSecureArtifactPath(paths.directory, 'directory');
    assertSecureArtifactPath(paths.metadataPath, 'file');
    raw = readFileSync(paths.metadataPath, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) return { status: 'missing', metadataPath: paths.metadataPath };
    return {
      status: 'invalid',
      metadataPath: paths.metadataPath,
      diagnostic: diagnosticForInvalidMetadata(error),
    };
  }
  const decoded = decodeHarnessMetadata(raw);
  return decoded.status === 'valid'
    ? { status: 'valid', metadata: decoded.metadata, metadataPath: paths.metadataPath }
    : { status: 'invalid', metadataPath: paths.metadataPath, diagnostic: decoded.diagnostic };
}

/**
 * Decodes the text of a `harness.json`.
 *
 * It accepts exactly what the hand-written parser it replaced accepted, and words each rejection
 * the same way, because the diagnostic is persisted and shown as the session's status reason. The
 * schema checks its keys in declaration order and stops at the first problem, which is the order
 * the old parser checked them in.
 */
export function decodeHarnessMetadata(
  raw: string,
):
  | { readonly status: 'valid'; readonly metadata: AgentSessionHarnessMetadata }
  | { readonly status: 'invalid'; readonly diagnostic: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { status: 'invalid', diagnostic: diagnosticForInvalidMetadata(error) };
  }
  const decoded = Schema.decodeUnknownResult(harnessMetadataSchema)(parsed);
  if (Result.isSuccess(decoded)) return { status: 'valid', metadata: decoded.success };
  const [key] = formatMetadataIssue(decoded.failure.issue).issues[0]?.path ?? [];
  return {
    status: 'invalid',
    diagnostic: `Invalid harness metadata: ${metadataProblem(parsed, key)}`,
  };
}

function metadataProblem(parsed: unknown, key: unknown) {
  switch (key) {
    case 'harnessSessionId':
      return 'Invalid harnessSessionId.';
    case 'updatedAt':
      return 'Invalid updatedAt.';
    case 'schemaVersion':
      return 'Unsupported metadata schema version.';
    default:
      // The schema rejects an array as a whole; the old parser saw an object without a schema version.
      return parsed !== null && typeof parsed === 'object'
        ? 'Unsupported metadata schema version.'
        : 'Metadata must be an object.';
  }
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
