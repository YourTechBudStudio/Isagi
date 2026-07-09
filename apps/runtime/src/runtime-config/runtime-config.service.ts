import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Context, Data, Effect, Layer } from 'effect';
import { parse, stringify } from 'yaml';

import { DataDirectory } from '../persistence/index.js';
import {
  defaultRuntimeConfig,
  parseRuntimeConfig,
  type RuntimeConfigPtyBackend,
  type RuntimeConfigShape,
} from './runtime-config.schema.js';

export class RuntimeConfigError extends Data.TaggedError('RuntimeConfigError')<{
  readonly path: string;
  readonly cause: unknown;
}> {}

export const RuntimeConfig = Context.GenericTag<RuntimeConfigShape>('isagi/RuntimeConfig');

export const RuntimeConfigLive = Layer.effect(
  RuntimeConfig,
  Effect.gen(function* () {
    const directory = yield* DataDirectory;
    const path = resolve(directory.paths.root, 'config.yaml');
    return yield* readOrCreateRuntimeConfig(path);
  }),
);

function readOrCreateRuntimeConfig(
  path: string,
): Effect.Effect<RuntimeConfigShape, RuntimeConfigError> {
  return Effect.try({
    try: () => {
      if (!existsSync(path)) {
        writeFileSync(path, stringify(defaultRuntimeConfig), 'utf8');
        return defaultRuntimeConfig;
      }
      return parseRuntimeConfig(parse(readFileSync(path, 'utf8')));
    },
    catch: (cause) => new RuntimeConfigError({ path, cause }),
  });
}
export type { RuntimeConfigPtyBackend, RuntimeConfigShape };
