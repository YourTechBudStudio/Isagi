import { Schema } from 'effect';

export const runtimeConfigPtyBackendSchema = Schema.Literal('node-pty', 'tmux').annotations({
  description:
    'PTY backend used for new process launches. This is process-scoped runtime config: changing it requires restarting Isagi.',
});

export const runtimeConfigSchema = Schema.Struct({
  pty: Schema.optional(
    Schema.Struct({
      backend: Schema.optional(Schema.NullOr(runtimeConfigPtyBackendSchema)).annotations({
        description:
          'PTY backend for runtime-managed terminals and agents. Use node-pty unless tmux is deliberately selected. Missing or null defaults to node-pty. Changing this requires restarting Isagi.',
      }),
    }),
  ).annotations({
    description:
      'PTY runtime settings. Runtime config is read when the runtime starts, so changes require restart.',
  }),
}).annotations({
  description: 'Runtime Isagi config from <dataRoot>/config.yaml.',
});

export type RuntimeConfigPtyBackend = Schema.Schema.Type<typeof runtimeConfigPtyBackendSchema>;

export interface RuntimeConfigShape {
  readonly pty: {
    readonly backend: RuntimeConfigPtyBackend;
  };
}

export const defaultRuntimeConfig = {
  pty: { backend: 'node-pty' },
} as const satisfies RuntimeConfigShape;

export function parseRuntimeConfig(value: unknown): RuntimeConfigShape {
  if (!isRecord(value) || !isRecord(value.pty)) {
    return defaultRuntimeConfig;
  }
  const backend = value.pty.backend;
  if (backend === null || backend === undefined) {
    return defaultRuntimeConfig;
  }
  return { pty: { backend: Schema.decodeUnknownSync(runtimeConfigPtyBackendSchema)(backend) } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
