import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { Context, Data, Effect, Layer, Ref } from 'effect';
import { Document, isMap, parseDocument } from 'yaml';

import { DataDirectory } from '../persistence/index.js';
import {
  defaultRuntimeConfig,
  parseRuntimeConfig,
  type RuntimeConfigShape,
  type RuntimeHarnessPolicy,
} from './runtime-config.policy.js';
import type { RuntimeConfigPtyBackend } from './runtime-config.schema.js';

export class RuntimeConfigError extends Data.TaggedError('RuntimeConfigError')<{
  readonly path: string;
  readonly cause: unknown;
}> {}
export class RuntimeConfigConflict extends Data.TaggedError('RuntimeConfigConflict')<{
  readonly expectedRevision: string;
  readonly actualRevision: string;
}> {}
export class RuntimeHarnessConfigInvalid extends Data.TaggedError('RuntimeHarnessConfigInvalid')<{
  readonly diagnostic: string;
}> {}
export interface RuntimeConfigService {
  readonly get: Effect.Effect<RuntimeConfigShape>;
  readonly acceptHarnessPolicy: (input: {
    readonly expectedPolicyRevision: string;
    readonly policy: RuntimeHarnessPolicy;
  }) => Effect.Effect<
    RuntimeConfigShape,
    RuntimeConfigError | RuntimeConfigConflict | RuntimeHarnessConfigInvalid
  >;
}
export const RuntimeConfig = Context.GenericTag<RuntimeConfigService>('isagi/RuntimeConfig');
export const RuntimeConfigLive = Layer.effect(
  RuntimeConfig,
  Effect.gen(function* () {
    const directory = yield* DataDirectory;
    const path = resolve(directory.paths.root, 'config.yaml');
    const initial = yield* readOrCreateRuntimeConfig(path);
    const state = yield* Ref.make(initial);
    const semaphore = yield* Effect.makeSemaphore(1);
    return {
      get: Ref.get(state),
      acceptHarnessPolicy: (input) =>
        semaphore.withPermits(1)(
          Effect.gen(function* () {
            const bytes = yield* readBytes(path);
            const sourceIdentity = identity(bytes);
            const document = yield* parseYamlDocument(path, bytes);
            const current = parseRuntimeConfig(document.toJS());
            if (current.harnesses.status === 'invalid')
              return yield* Effect.fail(
                new RuntimeHarnessConfigInvalid({
                  diagnostic: current.harnesses.diagnostic ?? 'Invalid harnesses configuration.',
                }),
              );
            if (current.harnesses.revision !== input.expectedPolicyRevision)
              return yield* Effect.fail(
                new RuntimeConfigConflict({
                  expectedRevision: input.expectedPolicyRevision,
                  actualRevision: current.harnesses.revision,
                }),
              );
            patchHarnessPolicy(document, input.policy);
            const nextBytes = document.toString();
            // Preserve edits made by an external YAML editor after this mutation read its source.
            // This narrows the unavoidable check-to-rename race without exposing persistence tokens.
            const latest = yield* readBytes(path);
            if (identity(latest) !== sourceIdentity) {
              const latestDoc = yield* parseYamlDocument(path, latest);
              return yield* Effect.fail(
                new RuntimeConfigConflict({
                  expectedRevision: input.expectedPolicyRevision,
                  actualRevision: parseRuntimeConfig(latestDoc.toJS()).harnesses.revision,
                }),
              );
            }
            yield* atomicWrite(path, nextBytes);
            const next = parseRuntimeConfig(document.toJS());
            yield* Ref.set(state, next);
            return next;
          }),
        ),
    } satisfies RuntimeConfigService;
  }),
);
function readOrCreateRuntimeConfig(path: string) {
  return Effect.try({
    try: () => {
      try {
        const bytes = readFileSync(path, 'utf8');
        const doc = parseDocument(bytes);
        if (doc.errors.length) throw doc.errors[0];
        return parseRuntimeConfig(doc.toJS());
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const document = new Document({ pty: { backend: defaultRuntimeConfig.pty.backend } });
        writeFileSync(path, document.toString(), 'utf8');
        return defaultRuntimeConfig;
      }
    },
    catch: (cause) => new RuntimeConfigError({ path, cause }),
  });
}
function readBytes(path: string) {
  return Effect.try({
    try: () => readFileSync(path, 'utf8'),
    catch: (cause) => new RuntimeConfigError({ path, cause }),
  });
}
function parseYamlDocument(path: string, bytes: string) {
  return Effect.try({
    try: () => {
      const doc = parseDocument(bytes);
      if (doc.errors.length) throw doc.errors[0];
      return doc;
    },
    catch: (cause) => new RuntimeConfigError({ path, cause }),
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
    catch: (cause) => new RuntimeConfigError({ path, cause }),
  });
}
function identity(bytes: string) {
  return createHash('sha256').update(bytes).digest('hex');
}
export type { RuntimeConfigPtyBackend, RuntimeConfigShape };
