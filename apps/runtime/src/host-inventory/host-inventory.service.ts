import { Context, Deferred, Effect, Layer, Ref } from 'effect';

import {
  approvedHostEnvironmentKeys,
  type ApprovedHostEnvironment,
  type HarnessProbeDefinition,
} from '../agent-sessions/harness/definition-types.js';
import { harnessDefinitions } from '../agent-sessions/harness/definitions.js';
import type {
  ExecutableProbeResult,
  HostEnvironmentResult,
  HostInventory as HostInventorySnapshot,
  HostInventoryState,
} from './types.js';
import { UserShell, type UserShellCommandResult } from './user-shell.service.js';

const probeTimeoutMs = 5_000;
const probeOutputLimitBytes = 16 * 1024;

export interface HostInventoryService {
  readonly getCached: Effect.Effect<HostInventoryState>;
  readonly startRefresh: Effect.Effect<void>;
  readonly refresh: Effect.Effect<HostInventorySnapshot>;
}

export const HostInventory = Context.GenericTag<HostInventoryService>('isagi/HostInventory');

export const HostInventoryLive = Layer.scoped(
  HostInventory,
  Effect.gen(function* () {
    const shell = yield* UserShell;
    const scope = yield* Effect.scope;
    const state = yield* Ref.make<HostInventoryState>({ _tag: 'Pending' });
    const activeRefresh = yield* Ref.make<Deferred.Deferred<HostInventorySnapshot> | null>(null);
    const generation = yield* Ref.make(0);

    const collect = collectHostInventory(shell);
    const beginRefresh = Effect.uninterruptibleMask(() =>
      Effect.gen(function* () {
        const candidate = yield* Deferred.make<HostInventorySnapshot>();
        const selected = yield* Ref.modify(
          activeRefresh,
          (
            active,
          ): readonly [
            (
              | {
                  readonly owner: false;
                  readonly deferred: Deferred.Deferred<HostInventorySnapshot>;
                }
              | {
                  readonly owner: true;
                  readonly deferred: Deferred.Deferred<HostInventorySnapshot>;
                }
            ),
            Deferred.Deferred<HostInventorySnapshot>,
          ] =>
            active
              ? [{ owner: false, deferred: active }, active]
              : [{ owner: true, deferred: candidate }, candidate],
        );
        if (selected.owner) {
          yield* Effect.forkIn(
            Effect.interruptible(
              collect.pipe(
                Effect.tap((inventory) =>
                  Effect.gen(function* () {
                    const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
                    const nextGeneration = yield* Ref.updateAndGet(
                      generation,
                      (value) => value + 1,
                    );
                    yield* Ref.set(state, {
                      _tag: 'Ready',
                      generation: nextGeneration,
                      inventory,
                      refreshedAt: new Date(now).toISOString(),
                    });
                    yield* Deferred.succeed(selected.deferred, inventory);
                  }),
                ),
                Effect.ensuring(Ref.set(activeRefresh, null)),
              ),
            ),
            scope,
          );
        }
        return selected.deferred;
      }),
    );
    const refresh = Effect.flatMap(beginRefresh, Deferred.await);

    return {
      getCached: Ref.get(state),
      startRefresh: Effect.asVoid(beginRefresh),
      refresh,
    } satisfies HostInventoryService;
  }),
);

function collectHostInventory(shell: Context.Tag.Service<typeof UserShell>) {
  return Effect.gen(function* () {
    const [pi, opencode, claude, codex] = yield* Effect.all(
      [
        probeVersion(shell, harnessDefinitions.pi.probe),
        probeVersion(shell, harnessDefinitions.opencode.probe),
        probeVersion(shell, harnessDefinitions.claude.probe),
        probeVersion(shell, harnessDefinitions.codex.probe),
      ],
      { concurrency: 'unbounded' },
    );
    return {
      environment: approvedEnvironmentResult(shell.environment),
      harnesses: { pi, opencode, claude, codex },
    } satisfies HostInventorySnapshot;
  });
}

function probeVersion(shell: Context.Tag.Service<typeof UserShell>, probe: HarnessProbeDefinition) {
  return runProbe(shell, probe).pipe(
    Effect.map((result): ExecutableProbeResult => {
      const failure = probeFailure(probe.command, result);
      if (failure) return failure;
      const version = versionLines(result.stdout).at(-1) ?? versionLines(result.stderr).at(-1);
      if (!version) return malformedProbe(probe.command, 'Version output was unusable.');
      return { _tag: 'Available', command: probe.command, version: version.slice(0, 256) };
    }),
  );
}

function runProbe(shell: Context.Tag.Service<typeof UserShell>, probe: HarnessProbeDefinition) {
  return shell.run({ ...probe, timeoutMs: probeTimeoutMs, maxOutputBytes: probeOutputLimitBytes });
}

function probeFailure(
  command: string,
  result: UserShellCommandResult,
): ExecutableProbeResult | null {
  if (result.timedOut) return failedProbe(command, 'timeout', 'Probe timed out.');
  if (result.outputTruncated) {
    return failedProbe(command, 'output_limit_exceeded', 'Probe output exceeded its limit.');
  }
  if (result.spawnError) return failedProbe(command, 'spawn_failed', result.spawnError);
  if (result.exitCode === 127) {
    return { _tag: 'Missing', command };
  }
  if (result.exitCode !== 0) {
    return failedProbe(command, 'nonzero_exit', conciseFailure(result));
  }
  return null;
}

function malformedProbe(command: string, diagnostic: string): ExecutableProbeResult {
  return failedProbe(command, 'malformed_output', diagnostic);
}

function failedProbe(
  command: string,
  reason: Extract<ExecutableProbeResult, { readonly _tag: 'ProbeFailed' }>['reason'],
  diagnostic: string,
): ExecutableProbeResult {
  return { _tag: 'ProbeFailed', command, reason, diagnostic: diagnostic.slice(0, 512) };
}

function conciseFailure(result: UserShellCommandResult) {
  const detail =
    result.stderr.trim() || result.stdout.trim() || result.spawnError || 'Probe failed.';
  return detail.slice(0, 512);
}

function versionLines(output: string) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && /\d/.test(line));
}

function approvedEnvironment(environment: NodeJS.ProcessEnv): ApprovedHostEnvironment {
  return Object.fromEntries(
    approvedHostEnvironmentKeys.flatMap((key) => {
      const value = environment[key];
      return value ? [[key, value]] : [];
    }),
  );
}

function approvedEnvironmentResult(
  environment: Context.Tag.Service<typeof UserShell>['environment'],
): HostEnvironmentResult {
  const values = approvedEnvironment(environment.values);
  return environment._tag === 'Available'
    ? { _tag: 'Available', values }
    : { _tag: 'ProbeFailed', values, diagnostic: environment.diagnostic };
}
