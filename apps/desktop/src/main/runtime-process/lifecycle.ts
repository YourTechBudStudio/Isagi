import { Data, Effect } from 'effect';

import {
  HOST_RUNTIME_STATUS_PROTOCOL_VERSION,
  type HostRuntimeDiagnostic,
  type HostRuntimeFailureReason,
  type HostRuntimeStatusSnapshot,
} from '@isagi/contracts';

import { LosslessLineDecoder, type DecodedLine } from './line-decoder.js';
import type {
  RuntimeChildProcess,
  RuntimeProcessAdapter,
  RuntimeSpawnSpecification,
} from './process-adapter.js';

const readyPrefix = 'ISAGI_RUNTIME_READY ';

export type RuntimeTarget =
  | {
      readonly ownership: 'managed';
      readonly prepare: () => RuntimeSpawnSpecification;
    }
  | {
      readonly ownership: 'external';
      readonly url: string;
    };

export interface RuntimeLifecycleDependencies {
  readonly processAdapter: RuntimeProcessAdapter;
  readonly checkHealth: (url: string) => Promise<void>;
  readonly log: (record: {
    readonly stream: 'stdout' | 'stderr';
    readonly payload: string;
  }) => void;
  readonly readinessTimeoutMs?: number | undefined;
  readonly stopGraceMs?: number | undefined;
}

export class RuntimeLifecycleFailure extends Data.TaggedError('RuntimeLifecycleFailure')<{
  readonly reason: Exclude<HostRuntimeFailureReason, 'external_health_check_failed'>;
  readonly diagnostic: HostRuntimeDiagnostic;
}> {
  override get message() {
    return this.diagnostic.message ?? this.reason;
  }
}

type InternalState =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'unreachable'
  | 'stopping'
  | 'stopped'
  | 'failed';
type StartWaiter = (effect: Effect.Effect<void, RuntimeLifecycleFailure>) => void;
type SnapshotFacts = HostRuntimeStatusSnapshot extends infer Snapshot
  ? Snapshot extends HostRuntimeStatusSnapshot
    ? Omit<Snapshot, 'protocolVersion' | 'revision'>
    : never
  : never;

export class RuntimeLifecycle {
  readonly #target: RuntimeTarget;
  readonly #dependencies: RuntimeLifecycleDependencies;
  readonly #listeners = new Set<(snapshot: HostRuntimeStatusSnapshot) => void>();
  readonly #startWaiters = new Set<StartWaiter>();
  #state: InternalState = 'idle';
  #snapshot: HostRuntimeStatusSnapshot;
  #revision = 0;
  #child: RuntimeChildProcess | undefined;
  #runtimeUrl: string | undefined;
  #failure: RuntimeLifecycleFailure | undefined;
  #readinessTimer: NodeJS.Timeout | undefined;
  #failureEscalationTimer: NodeJS.Timeout | undefined;
  #stopPromise: Promise<void> | undefined;
  #resolveStopped: (() => void) | undefined;
  #stdoutDecoder: LosslessLineDecoder | undefined;
  #stderrDecoder: LosslessLineDecoder | undefined;

  constructor(target: RuntimeTarget, dependencies: RuntimeLifecycleDependencies) {
    this.#target = target;
    this.#dependencies = dependencies;
    this.#snapshot = {
      protocolVersion: HOST_RUNTIME_STATUS_PROTOCOL_VERSION,
      revision: 0,
      ownership: target.ownership,
      state: 'connecting',
    };
  }

  get snapshot(): HostRuntimeStatusSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: (snapshot: HostRuntimeStatusSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  start(): Effect.Effect<void, RuntimeLifecycleFailure> {
    return Effect.async<void, RuntimeLifecycleFailure>((resume) => {
      if (this.#state === 'ready') {
        resume(Effect.void);
        return;
      }
      if (this.#state === 'unreachable') {
        resume(Effect.void);
        return;
      }
      if (this.#state === 'failed' && this.#failure) {
        resume(Effect.fail(this.#failure));
        return;
      }
      if (this.#state === 'stopping' || this.#state === 'stopped') {
        resume(
          Effect.fail(
            new RuntimeLifecycleFailure({
              reason: 'process_error',
              diagnostic: { message: 'Runtime lifecycle is stopping or stopped.' },
            }),
          ),
        );
        return;
      }

      this.#startWaiters.add(resume);
      if (this.#state === 'idle') {
        this.#state = 'starting';
        if (this.#target.ownership === 'external') this.#startExternal();
        else this.#startManaged();
      }
      return Effect.sync(() => this.#startWaiters.delete(resume));
    });
  }

  getUrl(): Effect.Effect<string, RuntimeLifecycleFailure> {
    if (this.#target.ownership === 'external') return Effect.succeed(this.#target.url);
    return this.start().pipe(
      Effect.flatMap(() =>
        this.#runtimeUrl
          ? Effect.succeed(this.#runtimeUrl)
          : Effect.fail(
              new RuntimeLifecycleFailure({
                reason: 'process_error',
                diagnostic: { message: 'Managed runtime became ready without a URL.' },
              }),
            ),
      ),
    );
  }

  stop(): Effect.Effect<void> {
    return Effect.promise(() => this.#stop());
  }

  async #startExternal() {
    try {
      await this.#dependencies.checkHealth(
        this.#target.ownership === 'external' ? this.#target.url : '',
      );
      if (this.#state !== 'starting') return;
      this.#state = 'ready';
      this.#transition({ ownership: 'external', state: 'ready' });
    } catch (error) {
      if (this.#state !== 'starting') return;
      this.#state = 'unreachable';
      this.#transition({
        ownership: 'external',
        state: 'unreachable',
        reason: 'external_health_check_failed',
        diagnostic: { message: 'The configured external runtime did not pass its health check.' },
      });
      this.#dependencies.log({
        stream: 'stderr',
        payload: `[external] health check failed: ${errorMessageWithoutUrl(error)}\n`,
      });
    }
    this.#settleStartWaiters(Effect.void);
  }

  #startManaged() {
    let specification: RuntimeSpawnSpecification;
    try {
      specification = this.#target.ownership === 'managed' ? this.#target.prepare() : impossible();
    } catch (error) {
      if (error instanceof RuntimeLifecycleFailure) {
        this.#failManaged(error.reason, error.diagnostic, false);
      } else {
        this.#failManaged('stage_invalid', { message: errorMessage(error) }, false);
      }
      return;
    }

    let child: RuntimeChildProcess;
    try {
      child = this.#dependencies.processAdapter.spawn(specification);
    } catch (error) {
      this.#failManaged('spawn_failed', { message: errorMessage(error) }, false);
      return;
    }

    this.#child = child;
    this.#stdoutDecoder = new LosslessLineDecoder();
    this.#stderrDecoder = new LosslessLineDecoder();
    child.stdout.on('data', this.#onStdout);
    child.stderr.on('data', this.#onStderr);
    child.once('error', this.#onProcessError);
    child.once('exit', this.#onProcessExit);
    this.#readinessTimer = setTimeout(
      () =>
        this.#failManaged(
          'readiness_timeout',
          {
            message: `Runtime did not report readiness within ${this.#dependencies.readinessTimeoutMs ?? 15_000}ms.`,
          },
          true,
        ),
      this.#dependencies.readinessTimeoutMs ?? 15_000,
    );
  }

  readonly #onStdout = (chunk: Buffer) => {
    for (const line of this.#stdoutDecoder?.write(chunk) ?? []) {
      this.#forwardLine('stdout', line);
      this.#observeReadyLine(line.payload);
    }
  };

  readonly #onStderr = (chunk: Buffer) => {
    for (const line of this.#stderrDecoder?.write(chunk) ?? []) this.#forwardLine('stderr', line);
  };

  #forwardLine(stream: 'stdout' | 'stderr', line: DecodedLine) {
    this.#dependencies.log({ stream, payload: `${line.payload}${line.ending}` });
  }

  #observeReadyLine(line: string) {
    if (this.#state !== 'starting' || this.#runtimeUrl || !line.startsWith(readyPrefix)) return;
    let url: string;
    try {
      const payload = JSON.parse(line.slice(readyPrefix.length)) as { readonly url?: unknown };
      if (typeof payload.url !== 'string') throw new Error('readiness payload has no string URL');
      url = validateManagedRuntimeUrl(payload.url);
    } catch (error) {
      this.#failManaged('readiness_malformed', { message: errorMessage(error) }, true);
      return;
    }
    this.#runtimeUrl = url;
    if (this.#readinessTimer) clearTimeout(this.#readinessTimer);
    this.#readinessTimer = undefined;
    void this.#finishManagedHealthCheck(url);
  }

  async #finishManagedHealthCheck(url: string) {
    try {
      await this.#dependencies.checkHealth(url);
    } catch (error) {
      if (this.#state === 'starting') {
        this.#failManaged('health_check_failed', { message: errorMessage(error) }, true);
      }
      return;
    }
    if (this.#state !== 'starting') return;
    this.#state = 'ready';
    this.#transition({ ownership: 'managed', state: 'ready' });
    this.#settleStartWaiters(Effect.void);
  }

  readonly #onProcessError = (error: Error) => {
    if (this.#state === 'stopping' || this.#state === 'stopped' || this.#state === 'failed') return;
    this.#failManaged(
      this.#state === 'starting' ? 'spawn_failed' : 'process_error',
      {
        message: error.message,
      },
      true,
    );
  };

  readonly #onProcessExit = (code: number | null, signal: NodeJS.Signals | null) => {
    this.#flushLogs();
    this.#detachChildListeners();
    this.#child = undefined;
    if (this.#readinessTimer) clearTimeout(this.#readinessTimer);
    this.#readinessTimer = undefined;
    if (this.#failureEscalationTimer) clearTimeout(this.#failureEscalationTimer);
    this.#failureEscalationTimer = undefined;

    if (this.#state === 'stopping') {
      this.#state = 'stopped';
      this.#settleStartWaiters(Effect.fail(stoppingFailure()));
      this.#resolveStopped?.();
      this.#resolveStopped = undefined;
      return;
    }
    if (this.#state === 'failed' || this.#state === 'stopped') return;
    this.#failManaged(
      this.#state === 'starting' ? 'exited_before_ready' : 'exited_after_ready',
      {
        message:
          this.#state === 'starting'
            ? 'Runtime exited before becoming ready.'
            : 'Runtime exited after becoming ready.',
        exitCode: code,
        signal,
      },
      false,
    );
  };

  #failManaged(
    reason: Exclude<HostRuntimeFailureReason, 'external_health_check_failed'>,
    diagnostic: HostRuntimeDiagnostic,
    terminateChild: boolean,
  ) {
    if (this.#state === 'failed' || this.#state === 'stopping' || this.#state === 'stopped') return;
    this.#state = 'failed';
    if (this.#readinessTimer) clearTimeout(this.#readinessTimer);
    this.#readinessTimer = undefined;
    const failure = new RuntimeLifecycleFailure({ reason, diagnostic });
    this.#failure = failure;
    this.#transition({ ownership: 'managed', state: 'failed', reason, diagnostic });
    this.#settleStartWaiters(Effect.fail(failure));
    if (terminateChild && this.#child) {
      this.#signalChild('SIGTERM');
      this.#failureEscalationTimer = setTimeout(
        () => this.#signalChild('SIGKILL'),
        this.#dependencies.stopGraceMs ?? 3_000,
      );
    }
  }

  #settleStartWaiters(effect: Effect.Effect<void, RuntimeLifecycleFailure>) {
    const waiters = [...this.#startWaiters];
    this.#startWaiters.clear();
    for (const resume of waiters) resume(effect);
  }

  async #stop() {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopPromise = this.#performStop();
    return this.#stopPromise;
  }

  async #performStop() {
    if (this.#state === 'stopped') return;
    this.#settleStartWaiters(Effect.fail(stoppingFailure()));
    if (!this.#child) {
      this.#state = 'stopped';
      return;
    }

    // This assignment is deliberately before the signal: synchronous or immediate
    // exit observation must classify it as intentional shutdown, never a crash.
    this.#state = 'stopping';
    if (this.#failureEscalationTimer) clearTimeout(this.#failureEscalationTimer);
    this.#failureEscalationTimer = undefined;
    const stopped = new Promise<void>((resolve) => {
      this.#resolveStopped = resolve;
    });
    this.#signalChild('SIGTERM');
    const graceMs = this.#dependencies.stopGraceMs ?? 3_000;
    if (!(await resolvesWithin(stopped, graceMs))) {
      this.#signalChild('SIGKILL');
      if (!(await resolvesWithin(stopped, 1_000))) {
        this.#dependencies.log({
          stream: 'stderr',
          payload: 'Managed runtime did not report exit after SIGKILL; abandoning observation.\n',
        });
        this.#flushLogs();
        this.#detachChildListeners();
        this.#child = undefined;
        this.#state = 'stopped';
        this.#resolveStopped?.();
        this.#resolveStopped = undefined;
      }
    }
  }

  #signalChild(signal: NodeJS.Signals) {
    if (!this.#child) return;
    try {
      this.#dependencies.processAdapter.signal(this.#child, signal);
    } catch (error) {
      this.#dependencies.log({
        stream: 'stderr',
        payload: `Failed to signal managed runtime with ${signal}: ${errorMessage(error)}\n`,
      });
      if (signal === 'SIGKILL') this.#resolveStopped?.();
    }
  }

  #flushLogs() {
    for (const line of this.#stdoutDecoder?.end() ?? []) this.#forwardLine('stdout', line);
    for (const line of this.#stderrDecoder?.end() ?? []) this.#forwardLine('stderr', line);
  }

  #detachChildListeners() {
    if (!this.#child) return;
    this.#child.stdout.off('data', this.#onStdout);
    this.#child.stderr.off('data', this.#onStderr);
    this.#child.off('error', this.#onProcessError);
    this.#child.off('exit', this.#onProcessExit);
  }

  #transition(next: SnapshotFacts) {
    const snapshot = {
      ...next,
      protocolVersion: HOST_RUNTIME_STATUS_PROTOCOL_VERSION,
      revision: ++this.#revision,
    } as HostRuntimeStatusSnapshot;
    // Snapshot publication and the revision increment are one synchronous causal transition.
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener(snapshot);
  }
}

function validateManagedRuntimeUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) {
    throw new Error('Managed runtime readiness URL must use http://127.0.0.1:<port>.');
  }
  return url.toString();
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function errorMessageWithoutUrl(error: unknown) {
  if (!(error instanceof Error)) return 'health request failed';
  if (URL.canParse(error.message)) return 'health request failed';
  return error.message.replace(/https?:\/\/\S+/g, '<external-runtime>');
}

function stoppingFailure() {
  return new RuntimeLifecycleFailure({
    reason: 'process_error',
    diagnostic: { message: 'Runtime lifecycle is stopping or stopped.' },
  });
}

function impossible(): never {
  throw new Error('Unreachable runtime target branch');
}

function resolvesWithin(promise: Promise<void>, timeoutMs: number) {
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    void promise.then(() => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}
