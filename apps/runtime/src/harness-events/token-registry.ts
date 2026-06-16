import { randomBytes } from 'node:crypto';

import { Context, Effect, Layer } from 'effect';

import type { AgentHarness } from '@isagi/contracts';

import { InternalRuntimeEventBus } from '../runtime-events/index.js';

export interface HarnessEventTokenRecord {
  readonly token: string;
  readonly agentSessionId: number;
  readonly ptyProcessId: number;
  readonly harness: AgentHarness;
  readonly createdAt: string;
}

export interface HarnessEventTokenRegistryService {
  readonly create: (input: {
    readonly agentSessionId: number;
    readonly ptyProcessId: number;
    readonly harness: AgentHarness;
  }) => Effect.Effect<HarnessEventTokenRecord>;
  readonly resolve: (token: string) => Effect.Effect<HarnessEventTokenRecord | null>;
  readonly revoke: (token: string) => Effect.Effect<void>;
  readonly revokeByPtyProcessId: (ptyProcessId: number) => Effect.Effect<void>;
}

export const HarnessEventTokenRegistry = Context.GenericTag<HarnessEventTokenRegistryService>(
  'isagi/HarnessEventTokenRegistry',
);

export const HarnessEventTokenRegistryLive = Layer.scoped(
  HarnessEventTokenRegistry,
  Effect.gen(function* () {
    const internalBus = yield* InternalRuntimeEventBus;
    const tokens = new Map<string, HarnessEventTokenRecord>();
    const tokensByPtyProcessId = new Map<number, Set<string>>();

    const service = {
      create: (input) =>
        Effect.sync(() => {
          const token = randomBytes(32).toString('base64url');
          const record = {
            token,
            agentSessionId: input.agentSessionId,
            ptyProcessId: input.ptyProcessId,
            harness: input.harness,
            createdAt: new Date().toISOString(),
          } satisfies HarnessEventTokenRecord;
          tokens.set(token, record);
          tokensByPtyProcessId.set(
            input.ptyProcessId,
            new Set([...(tokensByPtyProcessId.get(input.ptyProcessId) ?? []), token]),
          );
          return record;
        }),
      resolve: (token) => Effect.sync(() => tokens.get(token) ?? null),
      revoke: (token) =>
        Effect.sync(() => {
          const record = tokens.get(token);
          tokens.delete(token);
          if (!record) return;
          const processTokens = tokensByPtyProcessId.get(record.ptyProcessId);
          processTokens?.delete(token);
          if (processTokens?.size === 0) tokensByPtyProcessId.delete(record.ptyProcessId);
        }),
      revokeByPtyProcessId: (ptyProcessId) =>
        Effect.sync(() => {
          const processTokens = tokensByPtyProcessId.get(ptyProcessId);
          if (!processTokens) return;
          for (const token of processTokens) tokens.delete(token);
          tokensByPtyProcessId.delete(ptyProcessId);
        }),
    } satisfies HarnessEventTokenRegistryService;

    const subscription = yield* internalBus.subscribe({
      types: ['pty_process_exited', 'pty_process_failed', 'pty_process_killed'],
    });
    yield* Effect.addFinalizer(() => subscription.unsubscribe);
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const event = yield* subscription.take;
          if ('ptyProcessId' in event) {
            yield* service.revokeByPtyProcessId(event.ptyProcessId);
          }
        }),
      ),
    );

    return yield* Effect.acquireRelease(Effect.succeed(service), () =>
      Effect.sync(() => {
        tokens.clear();
        tokensByPtyProcessId.clear();
      }),
    );
  }),
);
