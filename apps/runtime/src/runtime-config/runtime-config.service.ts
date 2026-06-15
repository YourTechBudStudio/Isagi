import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Context, Data, Effect, Layer } from 'effect';
import { parse, stringify } from 'yaml';

import { DataDirectory } from '../persistence/index.js';

export type RuntimeConfigPtyBackend = 'node-pty' | 'tmux';

export interface RuntimeConfigShape {
  readonly pty: {
    readonly backend: RuntimeConfigPtyBackend;
  };
}

export class RuntimeConfigError extends Data.TaggedError('RuntimeConfigError')<{
  readonly path: string;
  readonly cause: unknown;
}> {}

export const RuntimeConfig = Context.GenericTag<RuntimeConfigShape>('isagi/RuntimeConfig');

const defaultRuntimeConfig: RuntimeConfigShape = {
  pty: { backend: 'node-pty' },
};

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
      return parseRuntimeConfig(parse(readFileSync(path, 'utf8')), path);
    },
    catch: (cause) => new RuntimeConfigError({ path, cause }),
  });
}

function parseRuntimeConfig(value: unknown, path: string): RuntimeConfigShape {
  const backend = isRecord(value) && isRecord(value.pty) ? value.pty.backend : undefined;
  if (backend === null || backend === undefined) {
    return defaultRuntimeConfig;
  }
  if (backend === 'node-pty' || backend === 'tmux') {
    return { pty: { backend } };
  }
  throw new Error(`${path}: pty.backend must be either "node-pty" or "tmux".`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
