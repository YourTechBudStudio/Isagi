import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { Context, Data, Effect, Layer, Ref, Semaphore } from 'effect';
import { Document, isMap, parseDocument, YAMLError } from 'yaml';

import {
  describeSafely,
  safeSystemErrorCode,
  type SafeDescription,
  type SafeDiagnostic,
} from '../platform/diagnostics/index.js';
import { DataDirectory } from '../platform/persistence/index.js';
import type { RuntimeConfigPtyBackend } from './config-schema.js';
import {
  defaultRuntimeConfig,
  parseRuntimeConfig,
  RuntimeConfigIssues,
  type RuntimeConfigShape,
  type RuntimeHarnessPolicy,
} from './policy.js';

/**
 * Why `config.yaml` could not be used, kept to fields that cannot carry config text: an allowlisted
 * system error code, a YAML error code and position, or schema issue paths. Never a parser or schema
 * message, which can quote the file, and the file can hold inline keys.
 */
export type RuntimeConfigFailure =
  | { readonly reason: 'read_failed' | 'write_failed'; readonly errno: string | null }
  | {
      readonly reason: 'yaml_syntax';
      readonly yamlCode: string;
      readonly line: number | null;
      readonly column: number | null;
    }
  | { readonly reason: 'schema_invalid'; readonly issuePaths: ReadonlyArray<string> };

export class RuntimeConfigError
  extends Data.TaggedError('RuntimeConfigError')<{
    readonly path: string;
    readonly failure: RuntimeConfigFailure;
    /** Authored from `path` and `failure` only, so `Cause.pretty` at startup stays safe. */
    readonly message: string;
  }>
  implements SafeDiagnostic
{
  [describeSafely](): SafeDescription {
    return { label: this.message, cause: null };
  }
}

/** The only way to build a `RuntimeConfigError`: it composes the safe `message`. */
export function runtimeConfigError(path: string, failure: RuntimeConfigFailure) {
  return new RuntimeConfigError({
    path,
    failure,
    message: runtimeConfigFailureMessage(path, failure),
  });
}

function runtimeConfigFailureMessage(path: string, failure: RuntimeConfigFailure): string {
  switch (failure.reason) {
    case 'read_failed':
    case 'write_failed': {
      const verb = failure.reason === 'read_failed' ? 'read' : 'written';
      return `config.yaml could not be ${verb}${failure.errno ? ` (${failure.errno})` : ''}: ${path}`;
    }
    case 'yaml_syntax': {
      const at = failure.line === null ? '' : ` at ${failure.line}:${failure.column ?? 0}`;
      return `config.yaml is not valid YAML (${failure.yamlCode}${at}): ${path}`;
    }
    case 'schema_invalid':
      return `config.yaml is invalid at ${failure.issuePaths.join(', ')}: ${path}`;
  }
}

function ioFailure(reason: 'read_failed' | 'write_failed', cause: unknown): RuntimeConfigFailure {
  const code =
    typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : null;
  return { reason, errno: safeSystemErrorCode(code) };
}

function yamlFailure(error: YAMLError): RuntimeConfigFailure {
  const position = error.linePos?.[0];
  return {
    reason: 'yaml_syntax',
    yamlCode: error.code,
    line: position?.line ?? null,
    column: position?.col ?? null,
  };
}
export class RuntimeConfigConflict extends Data.TaggedError('RuntimeConfigConflict')<{
  readonly expectedRevision: string;
  readonly actualRevision: string;
}> {}
export class RuntimeHarnessConfigInvalid extends Data.TaggedError('RuntimeHarnessConfigInvalid')<{
  readonly diagnostic: string;
}> {}
const make = Effect.gen(function* () {
  const directory = yield* DataDirectory;
  const path = resolve(directory.paths.root, 'config.yaml');
  const initial = yield* readOrCreateRuntimeConfig(path);
  const state = yield* Ref.make(initial);
  const semaphore = yield* Semaphore.make(1);
  return RuntimeConfig.of({
    get: Ref.get(state),
    // One mutation at a time: each re-reads the file, so a second writer sees the first one's revision.
    acceptHarnessPolicy: Effect.fn('RuntimeConfig.acceptHarnessPolicy')(function* (input: {
      readonly expectedPolicyRevision: string;
      readonly policy: RuntimeHarnessPolicy;
    }) {
      const bytes = yield* readBytes(path);
      const sourceIdentity = identity(bytes);
      const { document, config: current } = yield* readRuntimeConfigDocument(path, bytes);
      if (current.harnesses.status === 'invalid')
        return yield* new RuntimeHarnessConfigInvalid({
          diagnostic: current.harnesses.diagnostic ?? 'Invalid harnesses configuration.',
        });
      if (current.harnesses.revision !== input.expectedPolicyRevision)
        return yield* new RuntimeConfigConflict({
          expectedRevision: input.expectedPolicyRevision,
          actualRevision: current.harnesses.revision,
        });
      patchHarnessPolicy(document, input.policy);
      const nextBytes = document.toString();
      // Preserve edits made by an external YAML editor after this mutation read its source.
      // This narrows the unavoidable check-to-rename race without exposing persistence tokens.
      const latest = yield* readBytes(path);
      if (identity(latest) !== sourceIdentity) {
        const { config: latestConfig } = yield* readRuntimeConfigDocument(path, latest);
        return yield* new RuntimeConfigConflict({
          expectedRevision: input.expectedPolicyRevision,
          actualRevision: latestConfig.harnesses.revision,
        });
      }
      const next = yield* decodeRuntimeConfig(path, yield* documentValue(path, document));
      yield* atomicWrite(path, nextBytes);
      yield* Ref.set(state, next);
      return next;
    }, semaphore.withPermits(1)),
  });
});

export class RuntimeConfig extends Context.Service<
  RuntimeConfig,
  {
    readonly get: Effect.Effect<RuntimeConfigShape>;
    readonly acceptHarnessPolicy: (input: {
      readonly expectedPolicyRevision: string;
      readonly policy: RuntimeHarnessPolicy;
    }) => Effect.Effect<
      RuntimeConfigShape,
      RuntimeConfigError | RuntimeConfigConflict | RuntimeHarnessConfigInvalid
    >;
  }
>()('isagi/runtime/runtime-config/RuntimeConfig') {
  static readonly layer = Layer.effect(RuntimeConfig, make);
}
function readOrCreateRuntimeConfig(path: string) {
  return Effect.gen(function* () {
    const bytes = yield* Effect.try({
      try: () => readFileSync(path, 'utf8'),
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((cause) =>
        (cause as NodeJS.ErrnoException).code === 'ENOENT'
          ? Effect.succeed(null)
          : Effect.fail(runtimeConfigError(path, ioFailure('read_failed', cause))),
      ),
    );
    if (bytes === null) {
      const document = new Document({ pty: { backend: defaultRuntimeConfig.pty.backend } });
      yield* Effect.try({
        try: () => writeFileSync(path, document.toString(), 'utf8'),
        catch: (cause) => runtimeConfigError(path, ioFailure('write_failed', cause)),
      });
      return defaultRuntimeConfig;
    }
    return (yield* readRuntimeConfigDocument(path, bytes)).config;
  });
}

function decodeRuntimeConfig(path: string, value: unknown) {
  return Effect.suspend(() => {
    try {
      return Effect.succeed(parseRuntimeConfig(value));
    } catch (cause) {
      // Anything else `parseRuntimeConfig` throws is a defect, not a config failure.
      return cause instanceof RuntimeConfigIssues
        ? Effect.fail(
            runtimeConfigError(path, { reason: 'schema_invalid', issuePaths: cause.issuePaths }),
          )
        : Effect.die(cause);
    }
  });
}
function readBytes(path: string) {
  return Effect.try({
    try: () => readFileSync(path, 'utf8'),
    catch: (cause) => runtimeConfigError(path, ioFailure('read_failed', cause)),
  });
}
function parseYamlDocument(path: string, bytes: string) {
  const document = parseDocument(bytes);
  const [error] = document.errors;
  return error === undefined
    ? Effect.succeed(document)
    : Effect.fail(runtimeConfigError(path, yamlFailure(error)));
}
/**
 * The document as plain values. Conversion can fail after a clean parse (an unresolved alias, too
 * many aliases), and its error quotes the source, so it gets the same safe boundary as parsing.
 */
function documentValue(path: string, document: Document) {
  return Effect.try({
    try: (): unknown => document.toJS(),
    catch: (cause) =>
      runtimeConfigError(
        path,
        cause instanceof YAMLError
          ? yamlFailure(cause)
          : { reason: 'yaml_syntax', yamlCode: 'YAML_CONVERSION_FAILED', line: null, column: null },
      ),
  });
}
/** Parses and converts `bytes`, then decodes the config: every failure is a safe `RuntimeConfigError`. */
function readRuntimeConfigDocument(path: string, bytes: string) {
  return Effect.gen(function* () {
    const document = yield* parseYamlDocument(path, bytes);
    const config = yield* decodeRuntimeConfig(path, yield* documentValue(path, document));
    return { document, config };
  });
}
function patchHarnessPolicy(document: Document, policy: RuntimeHarnessPolicy) {
  if (!isMap(document.contents)) document.contents = document.createNode({});
  document.set('harnesses', Object.fromEntries(Object.entries(policy)));
}
function atomicWrite(path: string, content: string) {
  return Effect.try({
    try: () => {
      const temp = resolve(dirname(path), `.config.yaml.isagi-${randomUUID()}`);
      try {
        writeFileSync(temp, content, { encoding: 'utf8', flag: 'wx' });
        renameSync(temp, path);
      } catch (error) {
        try {
          unlinkSync(temp);
        } catch {}
        throw error;
      }
    },
    catch: (cause) => runtimeConfigError(path, ioFailure('write_failed', cause)),
  });
}
function identity(bytes: string) {
  return createHash('sha256').update(bytes).digest('hex');
}
export type { RuntimeConfigPtyBackend, RuntimeConfigShape };
