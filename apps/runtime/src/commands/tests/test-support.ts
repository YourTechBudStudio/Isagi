import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import websocket from '@fastify/websocket';
import { Cause, Effect, Layer, Logger, References } from 'effect';
import type { FastifyInstance } from 'fastify';

import { InternalEvents, RuntimeEvents } from '../../platform/events/index.js';
import { withApiServer } from '../../platform/http/testing.js';
import { EntityLock } from '../../platform/locks/index.js';
import { LoopbackPortProbe, LoopbackPortUnavailable } from '../../platform/net/index.js';
import { DatabaseError, DataDirectory } from '../../platform/persistence/index.js';
import { makeTestDataDirectory } from '../../platform/persistence/testing.js';
import { ProjectRepository } from '../../projects/index.js';
import { PtyService, type PtyProcessAllocation } from '../../pty-processes/index.js';
import type { PtyProcessRow } from '../../pty-processes/index.js';
import type { PtyAttachment, PtyProcessLaunchMetadata } from '../../pty-processes/testing.js';
import { fakePtyAllocation, fakeTerminateMany } from '../../pty-processes/testing.js';
import { registerCommandsRoutes } from '../api.js';
import type { ResolvedPortEntry } from '../ports.js';
import {
  CommandRepository,
  type CommandFinalizeResult,
  type CommandPtyLink,
  type CommandRunRow,
  type CommandStateRow,
} from '../repository.js';
import { CommandService } from '../service.js';
import { CommandSettings, type CommandTimings } from '../settings.js';

// ---------------------------------------------------------------------------
// API / websocket test support
// ---------------------------------------------------------------------------

export const idleAction = {
  worktreeId: 10,
  commandName: 'dev',
  summary: { name: 'dev', status: 'idle' as const, ports: [] },
};

export const idleLogMetadata = {
  worktreeId: 10,
  commandName: 'dev',
  status: 'idle' as const,
  latestRun: null,
};

export function withCommandsApi<A>(
  service: CommandService['Service'],
  run: (fastify: FastifyInstance) => Promise<A>,
  options: { readonly pty?: Partial<PtyService['Service']> | undefined } = {},
) {
  return withApiServer(
    Layer.mergeAll(
      Layer.succeed(CommandService, service),
      Layer.mock(PtyService)(options.pty ?? fakeCommandLogPtyService()),
    ),
    async (fastify, runtime) => {
      await fastify.register(websocket);
      registerCommandsRoutes(fastify, runtime);
    },
    run,
  );
}

export function commandService(
  overrides: Partial<CommandService['Service']> = {},
): CommandService['Service'] {
  return {
    listForWorktree: (worktreeId) =>
      Effect.succeed({ status: 'configured', worktreeId, commands: [], removedCommands: [] }),
    readLogMetadata: () => Effect.succeed(idleLogMetadata),
    run: () => Effect.succeed(idleAction),
    stop: () => Effect.succeed(idleAction),
    restart: () => Effect.succeed(idleAction),
    runPostCreateLifecycle: () => Effect.void,
    cleanupBeforeWorktreeDelete: () => Effect.void,
    cleanupBeforeWorktreePrune: () => Effect.void,
    ...overrides,
  };
}

export function delayedSucceed<A>(value: A) {
  return Effect.sleep(1).pipe(Effect.as(value));
}

/** The PTY members a command log stream reads; anything else is unimplemented (`Layer.mock`). */
export function fakeCommandLogPtyService(
  overrides: Partial<PtyService['Service']> = {},
): Partial<PtyService['Service']> {
  return {
    getAttachmentPlan: () =>
      Effect.succeed({
        session: fakePtyProcess(),
        replayBytes: 0,
        live: true,
        replaySource: 'file_log',
      }),
    replay: () => Effect.void,
    pin: () => Effect.void,
    unpin: () => Effect.void,
    isPinned: () => Effect.succeed(false),
    ...overrides,
  };
}

export function fakeAttachment(overrides: Partial<PtyAttachment> = {}): PtyAttachment {
  return {
    session: fakePtyProcess(),
    attachmentId: null,
    replayBytes: 0,
    live: true,
    detach: Effect.void,
    ...overrides,
  };
}

export function fakePtyProcess(
  overrides: Partial<Parameters<PtyService['Service']['replay']>[0]['session']> = {},
): Parameters<PtyService['Service']['replay']>[0]['session'] {
  return {
    id: 20,
    paneId: 1,
    surfaceId: 2,
    worktreeId: 10,
    backend: 'node_pty',
    backendRefJson: JSON.stringify({
      schemaVersion: 1,
      backend: 'node_pty',
      ptyProcessId: 20,
      pid: 1234,
    }),
    command: 'bash',
    args: [],
    argsJson: '[]',
    cwd: '/repo/isagi',
    status: 'running',
    statusReason: null,
    exitCode: null,
    signal: null,
    logMode: 'backend_file',
    logPath: null,
    createdAt: '2026-06-19T00:00:00.000Z',
    updatedAt: '2026-06-19T00:00:00.000Z',
    exitedAt: null,
    lastSeenAt: null,
    ...overrides,
  };
}

export function receiveMessagesUntilClose(ws: {
  readonly on: (event: 'message' | 'close', listener: (data: Buffer) => void) => void;
}) {
  return new Promise<unknown[]>((resolve) => {
    const messages: unknown[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    ws.on('close', () => resolve(messages));
  });
}

export async function waitUntil(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Service test support
// ---------------------------------------------------------------------------

export interface CommandRepositoryOptions {
  readonly states?: readonly CommandStateRow[];
  readonly runningStates?: readonly CommandStateRow[] | undefined;
  readonly runs?: CommandRunRow[] | undefined;
  readonly latestRun?: CommandRunRow | null | undefined;
  readonly pty?: Partial<PtyService['Service']> | undefined;
  // The PTY row the launch handshake re-reads after linking its run. Defaults to
  // absent, which is what every pre-existing test expects.
  readonly ptyProcess?: PtyProcessRow | null | undefined;
  // Fails that re-read, so a test can prove an unreadable row is never mistaken
  // for a dead process.
  readonly ptyProcessReadFault?: (() => DatabaseError | null | undefined) | undefined;
  // Answers per incarnation instead of with one row for every id. Returning
  // `undefined` falls through to `ptyProcess`.
  readonly ptyProcessById?:
    | ((ptyProcessId: number) => PtyProcessRow | null | undefined)
    | undefined;
  // Records the run→PTY link, so a test can prove it is written before anything
  // reaches a backend.
  readonly onRunLinked?:
    | ((input: { readonly runId: number; readonly ptyProcessId: number }) => void)
    | undefined;
  // Fails the link write, or makes it report a vanished run.
  readonly updateRunPtyOutcome?: (() => DatabaseError | 'missing' | null | undefined) | undefined;
  // Replaces the prune step's outcome: fail it, or hang it (`Effect.never`) to
  // hold a launch open at the point a test wants to cancel.
  readonly pruneOutcome?: (() => Effect.Effect<void, DatabaseError> | null | undefined) | undefined;
  readonly transitionFault?:
    | ((input: {
        readonly status: CommandStateRow['status'];
        readonly activePtyProcessId: number | null;
      }) => DatabaseError | null | undefined)
    | undefined;
  // Fails a whole finalize call, so a test can prove the run and state either
  // both move or neither does.
  readonly finalizeFault?:
    | ((input: {
        readonly keying: 'pty' | 'run';
        readonly ptyProcessId?: number | undefined;
        readonly runId?: number | undefined;
      }) => DatabaseError | null | undefined)
    | undefined;
  // Replaces the public event bus. Scenario harnesses pass a synchronous
  // recording bus so a published event is observable the instant the service
  // publishes it, with no drain fiber and no settle window.
  readonly eventBus?: Layer.Layer<RuntimeEvents> | undefined;
  // Fires with the repository's own mutable state rows immediately after a
  // worktree listing, which is the snapshot point every lifecycle pass plans
  // from. Splicing that array — or rewriting the config file — from here is how
  // a test forces a stale-plan race deterministically, with no clocks.
  readonly afterListStates?: ((states: CommandStateRow[]) => void) | undefined;
  // Runs before every state read, so a test can change config between a pass
  // selecting a command and its executor re-reading it under the lock.
  readonly beforeFindState?: (() => void) | undefined;
  // Records re-adoption calls, so a test can prove which incarnation a degraded
  // ownership repair bound the command to and what diagnostic it wrote.
  readonly onReadopt?:
    | ((input: {
        readonly commandName: string;
        readonly ptyProcessId: number;
        readonly diagnostic:
          | { readonly reason: CommandRunRow['diagnosticReason']; readonly detail: string | null }
          | undefined;
      }) => void)
    | undefined;
  readonly readoptFault?: (() => DatabaseError | null | undefined) | undefined;
  readonly onTransition?:
    | ((input: {
        readonly commandName: string;
        readonly status: CommandStateRow['status'];
        readonly activePtyProcessId: number | null;
        // The snapshot the *call* asked to write, not the row's resulting value.
        // Present only when the caller named `resolvedPorts`, so a test can tell
        // the marker (the single writer) apart from every transition that
        // preserves the column by omission. Reading the materialized row instead
        // would make every later transition look like a second writer.
        readonly resolvedPorts?: readonly ResolvedPortEntry[] | undefined;
      }) => void)
    | undefined;
  // Replaces the loggers for the whole run — layer construction included, so boot
  // convergence and the event-driven passes log into it too.
  readonly logger?: Layer.Layer<never> | undefined;
  // The commands module's tunables; the production defaults when omitted.
  readonly settings?: CommandTimings | undefined;
  // The loopback probe the command service runs endpoint resolution on.
  // Defaults to a stub that dies on contact, so every launch test whose command
  // declares no allocated ports proves — globally, without its own assertion —
  // that the launch performed no socket IO. A test that wants allocation builds
  // its own `commandPortProbe(...)` and keeps the `calls` recorder.
  readonly portProbe?: LoopbackPortProbe['Service'] | undefined;
  // The lock the command service serializes per-command work on; a fresh `EntityLock.layer` when omitted.
  readonly entityLock?: Layer.Layer<EntityLock> | undefined;
}

export async function runCommandService(rootPath: string, options: CommandRepositoryOptions = {}) {
  return runCommandServiceEffect(rootPath, (service) => service.listForWorktree(10), options);
}

export async function runCommandServiceEffect<A>(
  rootPath: string,
  effect: (
    service: import('../service.js').CommandService['Service'],
  ) => Effect.Effect<
    A,
    unknown,
    import('../service.js').CommandService | InternalEvents | RuntimeEvents
  >,
  options: CommandRepositoryOptions = {},
) {
  return CommandService.pipe(
    Effect.flatMap(effect),
    Effect.provide(CommandService.layerNoDeps),
    Effect.provide(options.entityLock ?? EntityLock.layer),
    Effect.provide(Layer.mock(ProjectRepository)(repository(rootPath))),
    Effect.provide(Layer.mock(CommandRepository)(commandRepository(options))),
    Effect.provide(
      Layer.mock(PtyService)({
        ...ptyService(options.pty),
        ...ptyProcessReads(
          options.ptyProcess ?? null,
          options.ptyProcessReadFault,
          options.ptyProcessById,
        ),
      }),
    ),
    Effect.provide(
      Layer.succeed(LoopbackPortProbe, options.portProbe ?? untouchableCommandPortProbe()),
    ),
    Effect.provide(Layer.succeed(DataDirectory, makeTestDataDirectory(rootPath))),
    Effect.provide(options.eventBus ?? RuntimeEvents.layer),
    Effect.provide(InternalEvents.layer),
    Effect.provide(
      options.settings ? Layer.succeed(CommandSettings, options.settings) : Layer.empty,
    ),
    Effect.provide(options.logger ?? Layer.empty),
    Effect.scoped,
    Effect.runPromise,
  );
}

/** An in-memory `CommandRepository` (provided with `Layer.mock`; `ensureState` is unimplemented). */
export function commandRepository(
  options: CommandRepositoryOptions = {},
): Omit<CommandRepository['Service'], 'ensureState'> {
  const states = [...(options.states ?? [])];
  const runs = options.runs ?? [];

  // Mirrors the real finalizers' guards — run completed only while `running`,
  // state transitioned only when the caller's keying guard holds — and models
  // their atomicity by mutating nothing at all when the injected fault fires.
  const finalize = (
    input: {
      readonly worktreeId: number;
      readonly commandName: string;
      readonly runStatus: Exclude<CommandRunRow['status'], 'running'>;
      readonly stateStatus: CommandStateRow['status'];
      readonly diagnosticReason?: CommandRunRow['diagnosticReason'] | undefined;
      readonly diagnosticDetail?: string | null | undefined;
    },
    keying: {
      readonly selectRun: () => CommandRunRow | null;
      readonly stateMatches: (state: CommandStateRow) => boolean;
      readonly fault: () => DatabaseError | null | undefined;
    },
  ): Effect.Effect<CommandFinalizeResult, DatabaseError> =>
    Effect.suspend(() => {
      const fault = keying.fault();
      if (fault) return Effect.fail(fault);
      const existingRun = keying.selectRun();
      let run = existingRun;
      let runCompleted = false;
      if (existingRun && existingRun.status === 'running') {
        run = {
          ...existingRun,
          status: input.runStatus,
          diagnosticReason: input.diagnosticReason ?? null,
          diagnosticDetail: input.diagnosticDetail ?? null,
          completedAt: '2026-06-19T00:00:01.000Z',
        };
        runs.splice(runs.indexOf(existingRun), 1, run);
        runCompleted = true;
      }
      const existingState =
        states.find(
          (state) =>
            state.worktreeId === input.worktreeId && state.commandName === input.commandName,
        ) ?? null;
      let state = existingState;
      let stateTransitioned = false;
      if (existingState && keying.stateMatches(existingState)) {
        state = {
          ...existingState,
          status: input.stateStatus,
          activePtyProcessId: null,
        };
        states.splice(states.indexOf(existingState), 1, state);
        options.onTransition?.({
          commandName: input.commandName,
          status: input.stateStatus,
          activePtyProcessId: null,
        });
        stateTransitioned = true;
      }
      return Effect.succeed({ run, runCompleted, stateTransitioned, state });
    });

  // Mirrors the real repository's shape exactly: one private writer under two
  // semantic mutations, so the fake cannot teach a rule the production code does
  // not have. `resolvedPorts` omitted keeps whatever the row holds; any array —
  // `[]` included — replaces it.
  const writeState = (input: {
    readonly worktreeId: number;
    readonly commandName: string;
    readonly status: CommandStateRow['status'];
    readonly activePtyProcessId?: number | null | undefined;
    readonly resolvedPorts: readonly ResolvedPortEntry[] | undefined;
  }) =>
    Effect.suspend(() => {
      const fault = options.transitionFault?.({
        status: input.status,
        activePtyProcessId: input.activePtyProcessId ?? null,
      });
      if (fault) return Effect.fail(fault);
      return Effect.sync(() => {
        options.onTransition?.({
          commandName: input.commandName,
          status: input.status,
          activePtyProcessId: input.activePtyProcessId ?? null,
          ...(input.resolvedPorts === undefined ? {} : { resolvedPorts: input.resolvedPorts }),
        });
        const existing = states.find(
          (state) =>
            state.worktreeId === input.worktreeId && state.commandName === input.commandName,
        );
        const next = {
          ...(existing ??
            commandState({
              commandName: input.commandName,
              status: input.status,
            })),
          status: input.status,
          activePtyProcessId: input.activePtyProcessId ?? null,
          resolvedPorts:
            input.resolvedPorts === undefined
              ? (existing?.resolvedPorts ?? null)
              : input.resolvedPorts,
        };
        if (existing) {
          states.splice(states.indexOf(existing), 1, next);
        } else {
          states.push(next);
        }
        return next;
      });
    });

  return {
    listStatesForWorktree: (worktreeId) =>
      Effect.sync(() => {
        const snapshot = states.filter((state) => state.worktreeId === worktreeId);
        options.afterListStates?.(states);
        return snapshot;
      }),
    findState: (input) =>
      Effect.sync(() => {
        options.beforeFindState?.();
        return (
          states.find(
            (state) =>
              state.worktreeId === input.worktreeId && state.commandName === input.commandName,
          ) ?? null
        );
      }),
    listRunningStates: Effect.succeed([...(options.runningStates ?? [])]),
    listSuspendedStates: Effect.sync(() => states.filter((state) => state.status === 'suspended')),
    listRunningStatesForWorktree: (worktreeId) =>
      Effect.succeed(
        (options.runningStates ?? []).filter((state) => state.worktreeId === worktreeId),
      ),
    // Derived from the same live arrays the mutations write, exactly as the real
    // repository derives them from the same two tables — so a test that seeds a
    // state pointer or a run link automatically gets the link the production
    // union would find, and a repair that moves a link is visible on the next read.
    listCommandPtyLinks: Effect.sync(() => fakeCommandPtyLinks(states, runs)),
    listCommandPtyLinksForWorktree: (worktreeId) =>
      Effect.sync(() =>
        fakeCommandPtyLinks(
          states.filter((state) => state.worktreeId === worktreeId),
          runs.filter((run) => run.worktreeId === worktreeId),
        ),
      ),
    listLinklessRunningRuns: Effect.sync(() =>
      runs.filter((run) => run.status === 'running' && run.ptyProcessId === null),
    ),
    transitionState: (input) => writeState({ ...input, resolvedPorts: undefined }),
    markLaunchInProgress: (input) =>
      writeState({
        worktreeId: input.worktreeId,
        commandName: input.commandName,
        status: 'running',
        activePtyProcessId: null,
        resolvedPorts: input.resolvedPorts,
      }),
    createRun: (input) =>
      Effect.sync(() => {
        const run = commandRun({
          commandName: input.commandName,
          status: input.status,
          ptyProcessId: input.ptyProcessId,
          diagnosticReason: input.diagnosticReason,
          diagnosticDetail: input.diagnosticDetail,
        });
        runs.push({
          ...run,
          id: runs.length + 1,
          worktreeId: input.worktreeId,
          completedAt: input.completedAt ?? run.completedAt,
        });
        return runs.at(-1)!;
      }),
    updateRunPty: (input) =>
      Effect.suspend(() => {
        const outcome = options.updateRunPtyOutcome?.();
        if (outcome instanceof DatabaseError) return Effect.fail(outcome);
        if (outcome === 'missing') return Effect.succeed(null);
        return Effect.sync(() => {
          options.onRunLinked?.({
            runId: input.runId,
            ptyProcessId: input.ptyProcessId,
          });
          const run = runs.find((candidate) => candidate.id === input.runId);
          if (!run) return options.latestRun ?? null;
          const updated = { ...run, ptyProcessId: input.ptyProcessId };
          runs.splice(runs.indexOf(run), 1, updated);
          return updated;
        });
      }),
    completeRun: (input) =>
      Effect.sync(() => {
        const run = runs.find((candidate) => candidate.id === input.runId);
        if (!run) return options.latestRun ?? null;
        const updated = {
          ...run,
          status: input.status,
          diagnosticReason: input.diagnosticReason ?? null,
          diagnosticDetail: input.diagnosticDetail ?? null,
          completedAt: '2026-06-19T00:00:01.000Z',
        };
        runs.splice(runs.indexOf(run), 1, updated);
        return updated;
      }),
    finalizeRunAndStateByPty: (input) =>
      finalize(input, {
        selectRun: () =>
          runs.findLast(
            (candidate) =>
              candidate.worktreeId === input.worktreeId &&
              candidate.commandName === input.commandName &&
              candidate.ptyProcessId === input.ptyProcessId,
          ) ?? null,
        stateMatches: (state) => state.activePtyProcessId === input.ptyProcessId,
        fault: () =>
          options.finalizeFault?.({
            keying: 'pty',
            ptyProcessId: input.ptyProcessId,
          }),
      }),
    finalizeRunAndStateByRun: (input) =>
      finalize(input, {
        selectRun: () =>
          runs.find(
            (candidate) =>
              candidate.id === input.runId &&
              candidate.worktreeId === input.worktreeId &&
              candidate.commandName === input.commandName,
          ) ?? null,
        stateMatches: (state) => state.status === 'running',
        fault: () => options.finalizeFault?.({ keying: 'run', runId: input.runId }),
      }),
    // Mirrors the real transaction: the state is upserted to `running` on the
    // target incarnation, and the newest run is reopened (or inserted) with its
    // link moved to the same target and the diagnostic written.
    readoptCommandIncarnation: (input) =>
      Effect.suspend(() => {
        const fault = options.readoptFault?.();
        if (fault) return Effect.fail(fault);
        return Effect.sync(() => {
          options.onReadopt?.({
            commandName: input.commandName,
            ptyProcessId: input.ptyProcessId,
            diagnostic: input.diagnostic,
          });
          const existingState = states.find(
            (state) =>
              state.worktreeId === input.worktreeId && state.commandName === input.commandName,
          );
          const state = {
            ...(existingState ??
              commandState({ commandName: input.commandName, status: 'running' })),
            status: 'running' as const,
            activePtyProcessId: input.ptyProcessId,
          };
          if (existingState) {
            states.splice(states.indexOf(existingState), 1, state);
          } else {
            states.push(state);
          }
          options.onTransition?.({
            commandName: input.commandName,
            status: 'running',
            activePtyProcessId: input.ptyProcessId,
          });

          const existingRun =
            runs.findLast(
              (candidate) =>
                candidate.worktreeId === input.worktreeId &&
                candidate.commandName === input.commandName,
            ) ?? null;
          const run: CommandRunRow = {
            ...(existingRun ?? commandRun({ commandName: input.commandName, status: 'running' })),
            worktreeId: input.worktreeId,
            id: existingRun?.id ?? runs.length + 1,
            ptyProcessId: input.ptyProcessId,
            status: 'running' as const,
            // Mirrors the conditional update: an omitted diagnostic preserves
            // whatever the run already carries.
            ...(input.diagnostic
              ? {
                  diagnosticReason: input.diagnostic.reason,
                  diagnosticDetail: input.diagnostic.detail,
                }
              : existingRun
                ? {}
                : { diagnosticReason: null, diagnosticDetail: null }),
            completedAt: null,
          };
          if (existingRun) {
            runs.splice(runs.indexOf(existingRun), 1, run);
          } else {
            runs.push(run);
          }
          return { state, run };
        });
      }),
    findLatestRun: (input) =>
      Effect.succeed(
        runs
          .filter(
            (run) => run.worktreeId === input.worktreeId && run.commandName === input.commandName,
          )
          .at(-1) ??
          options.latestRun ??
          null,
      ),
    findRunByPtyProcess: (ptyProcessId) =>
      Effect.succeed(
        runs.find((run) => run.ptyProcessId === ptyProcessId) ?? options.latestRun ?? null,
      ),
    pruneRunHistory: (input) =>
      Effect.suspend(() => {
        const injected = options.pruneOutcome?.();
        const body = Effect.sync(() => {
          const matching = runs
            .filter(
              (run) => run.worktreeId === input.worktreeId && run.commandName === input.commandName,
            )
            .sort((a, b) => b.id - a.id);
          const stale = matching.slice(Math.max(input.keep, 0));
          for (const run of stale) {
            const index = runs.indexOf(run);
            if (index >= 0) runs.splice(index, 1);
          }
          return stale;
        });
        return injected ? Effect.andThen(injected, body) : body;
      }),
  };
}

export function commandState(input: {
  readonly commandName: string;
  readonly status: CommandStateRow['status'];
  readonly id?: number | undefined;
  // Stated explicitly when a test cares which incarnation the state points at —
  // boot convergence and the deletion audit both read the pointer as one half of
  // the command↔incarnation link union.
  readonly activePtyProcessId?: number | null | undefined;
  // The remembered resolution a launch may reuse. Defaults to null, which is
  // what a command that has never successfully launched carries.
  readonly resolvedPorts?: readonly ResolvedPortEntry[] | null | undefined;
}): CommandStateRow {
  return {
    id: input.id ?? 1,
    worktreeId: 10,
    commandName: input.commandName,
    status: input.status,
    resolvedPorts: input.resolvedPorts ?? null,
    activePtyProcessId:
      input.activePtyProcessId !== undefined
        ? input.activePtyProcessId
        : input.status === 'running'
          ? 123
          : null,
    createdAt: '2026-06-19T00:00:00.000Z',
    updatedAt: '2026-06-19T00:00:00.000Z',
  };
}

export function commandRun(input: {
  readonly commandName: string;
  readonly status: CommandRunRow['status'];
  readonly ptyProcessId?: number | null | undefined;
  readonly diagnosticReason?: CommandRunRow['diagnosticReason'] | undefined;
  readonly diagnosticDetail?: string | null | undefined;
  // Distinct ids matter once a fixture carries more than one run — the residue
  // sweep and the finalizers are all run-keyed.
  readonly id?: number | undefined;
}): CommandRunRow {
  return {
    id: input.id ?? 1,
    worktreeId: 10,
    commandName: input.commandName,
    ptyProcessId: input.ptyProcessId ?? null,
    status: input.status,
    diagnosticReason: input.diagnosticReason ?? null,
    diagnosticDetail: input.diagnosticDetail ?? null,
    startedAt: '2026-06-19T00:00:00.000Z',
    completedAt: input.status === 'running' ? null : '2026-06-19T00:00:01.000Z',
    createdAt: '2026-06-19T00:00:00.000Z',
    updatedAt: '2026-06-19T00:00:00.000Z',
  };
}

// A command launch allocation that records the order of the one-shot machine's
// stages, so a test can prove the run→PTY link is written before anything
// reaches a backend. Phase violations (a second `start`) still die, because the
// enforcement lives in the shared `fakePtyAllocation`.
export function commandLaunchAllocation(input: {
  readonly ptyProcessId: number;
  readonly cwd: string;
  readonly logPath?: string | null | undefined;
  readonly calls?: string[] | undefined;
  readonly start?: Effect.Effect<PtyProcessLaunchMetadata> | undefined;
}): PtyProcessAllocation {
  const metadata: PtyProcessLaunchMetadata = {
    ptyProcessId: input.ptyProcessId,
    command: '/bin/sh',
    args: ['-lc', 'pnpm dev'],
    cwd: input.cwd,
    logPath: input.logPath ?? null,
  };
  input.calls?.push('allocate');
  return fakePtyAllocation({
    ptyProcessId: input.ptyProcessId,
    start: Effect.suspend(() => {
      input.calls?.push('start');
      return input.start ?? Effect.succeed(metadata);
    }),
    onAbandon: () => input.calls?.push('abandon'),
  });
}

// A strict persisted PTY row, for tests that exercise the launch handshake's
// re-read of the row it just linked.
export function fakePtyProcessRow(overrides: Partial<PtyProcessRow> = {}): PtyProcessRow {
  return {
    id: 902,
    backend: 'node_pty',
    backendRefJson: JSON.stringify({
      schemaVersion: 1,
      backend: 'node_pty',
      ptyProcessId: 902,
      pid: 4321,
    }),
    command: '/bin/sh',
    args: ['-lc', 'pnpm dev'],
    argsJson: JSON.stringify(['-lc', 'pnpm dev']),
    cwd: '/repo/isagi',
    status: 'running',
    statusReason: null,
    exitCode: null,
    signal: null,
    logMode: 'backend_file',
    logPath: null,
    createdAt: '2026-06-19T00:00:00.000Z',
    updatedAt: '2026-06-19T00:00:00.000Z',
    exitedAt: null,
    lastSeenAt: null,
    ...overrides,
  };
}

/** The PTY row reads commands make (`PtyService.findProcess`), answered from fixtures. */
export function ptyProcessReads(
  process: PtyProcessRow | null = null,
  readFault?: (() => DatabaseError | null | undefined) | undefined,
  // Per-id lookup for fixtures with more than one incarnation — divergence and
  // multi-link audits need each row to answer for itself. Falls back to the
  // single-row shape every earlier test uses.
  byId?: ((ptyProcessId: number) => PtyProcessRow | null | undefined) | undefined,
): Pick<PtyService['Service'], 'findProcess'> {
  return {
    findProcess: (ptyProcessId) =>
      Effect.suspend(() => {
        const fault = readFault?.();
        if (fault) return Effect.fail(fault);
        const found = byId?.(ptyProcessId);
        return Effect.succeed(found === undefined ? process : found);
      }),
  };
}

/**
 * The PTY members the command service uses, with neutral defaults. Provided with `Layer.mock`, so a member left
 * out (`allocateLaunch` and `launch` unless overridden, the attach/log members always) is unimplemented.
 */
export function ptyService(
  overrides: Partial<PtyService['Service']> = {},
): Partial<PtyService['Service']> {
  const terminate: PtyService['Service']['terminate'] =
    overrides.terminate ?? (() => Effect.succeed('terminated_live' as const));
  return {
    ...(overrides.allocateLaunch ? { allocateLaunch: overrides.allocateLaunch } : {}),
    ...(overrides.launch ? { launch: overrides.launch } : {}),
    replay: () => Effect.void,
    write: () => Effect.void,
    writeInput: () => Effect.void,
    resize: () => Effect.void,
    kill: () => Effect.succeed('terminated_live' as const),
    terminate,
    terminateMany: overrides.terminateMany ?? fakeTerminateMany(terminate),
    findProcess: overrides.findProcess ?? (() => Effect.succeed(null)),
    // Neutral by default: "there was nothing left to stop". Boot convergence
    // runs during every service construction, so a fixture that is not about
    // boot must be able to be built without stating a cleanup outcome — and the
    // neutral outcome writes no command row unless the state also claims to be
    // running. Tests about boot or deletion override this.
    cleanupProcess: overrides.cleanupProcess ?? (() => Effect.succeed('already_terminal' as const)),
    pin: overrides.pin ?? (() => Effect.void),
    unpin: overrides.unpin ?? (() => Effect.void),
    isPinned: overrides.isPinned ?? (() => Effect.succeed(false)),
  };
}

/** A `ProjectRepository` knowing one worktree (id 10) at `rootPath`; provided with `Layer.mock`. */
export function repository(
  rootPath: string,
): Omit<
  ProjectRepository['Service'],
  'createProject' | 'moveProjectOrder' | 'moveProjectWorktreeOrder'
> {
  return {
    findProject: () => Effect.succeed(null),
    findProjectByRootPath: () => Effect.succeed(null),
    findWorktree: (worktreeId) =>
      Effect.succeed(
        worktreeId === 10
          ? {
              id: 10,
              projectId: 1,
              path: rootPath,
              branch: 'main',
              head: 'abcdef0',
              createdAt: '2026-06-19T00:00:00.000Z',
              updatedAt: '2026-06-19T00:00:00.000Z',
              firstSeenAt: '2026-06-19T00:00:00.000Z',
              lastSeenAt: '2026-06-19T00:00:00.000Z',
            }
          : null,
      ),
    findProjectWorktree: () => Effect.succeed(null),
    findProjectRootWorktree: () => Effect.succeed(null),
    findProjectWorktreeByBranch: () => Effect.succeed(null),
    findProjectWorktreeByPath: () => Effect.succeed(null),
    deleteProject: () => Effect.succeed(false),
    deleteWorktree: () => Effect.succeed(false),
    listProjects: Effect.succeed([]),
    listWorktrees: Effect.succeed([]),
    reconcileProjectWorktrees: () => Effect.succeed({ added: [], missing: [] }),
    restoreProjectAtRootPath: () => Effect.succeed({ added: [], missing: [] }),
    setProjectStatus: () => Effect.void,
  };
}

export function createFixture() {
  const rootPath = mkdtempSync(join(tmpdir(), 'isagi-command-worktree-'));
  return {
    rootPath,
    cleanup: () => rmSync(rootPath, { recursive: true, force: true }),
  };
}

export function writeConfig(rootPath: string, contents: string) {
  const configDir = join(rootPath, '.isagi');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.yaml'), contents);
}

// ---------------------------------------------------------------------------
// Lifecycle scenario harness
// ---------------------------------------------------------------------------

export interface CommandScenarioRecorder {
  readonly transitions: Array<{
    readonly commandName: string;
    readonly status: CommandStateRow['status'];
    readonly activePtyProcessId: number | null;
    // Present only when the transition call named it — see `onTransition`.
    readonly resolvedPorts?: readonly ResolvedPortEntry[] | undefined;
  }>;
  readonly published: Array<{ readonly commandName: string; readonly status: string }>;
  // The runtime's Effect log lines, rendered `<level> <message> <key>=<value>…`.
  readonly logs: string[];
  readonly terminated: number[];
  // Generic cleanup attempts, in order, with the flags the caller chose. Boot
  // and the deletion audit differ on exactly those flags, so recording them is
  // how a test proves which pass it is watching.
  readonly cleaned: Array<{
    readonly ptyProcessId: number;
    readonly reason: string;
    readonly ensureBackendAbsence: boolean;
  }>;
  readonly readopted: Array<{
    readonly commandName: string;
    readonly ptyProcessId: number;
    readonly diagnostic:
      | { readonly reason: CommandRunRow['diagnosticReason']; readonly detail: string | null }
      | undefined;
  }>;
  readonly launched: string[];
  readonly runs: CommandRunRow[];
  // Boot convergence runs during service construction, so a scenario about a
  // *body-time* pass has to be able to draw a line between what boot did and
  // what it is actually testing. `runs` is deliberately not cleared: it is
  // durable fixture state, not a record of calls.
  readonly reset: () => void;
}

/**
 * Drives the real `CommandService.layerNoDeps` with everything a lifecycle scenario
 * needs to observe: durable state transitions, published `command_changed`
 * events, the runtime's own log lines (which are also how a pass signals it
 * finished), terminate calls, and re-adoptions.
 *
 * Effect log output is captured rather than printed, so the log lines a scenario
 * asserts on carry the same message and annotations a user would see in support.
 */
export async function runCommandScenario<A>(
  rootPath: string,
  body: (input: {
    readonly service: CommandService['Service'];
    readonly internalEvents: InternalEvents['Service'];
    readonly recorder: CommandScenarioRecorder;
  }) => Effect.Effect<A, unknown, CommandService | InternalEvents | RuntimeEvents>,
  options: CommandRepositoryOptions = {},
) {
  const recorder: CommandScenarioRecorder = {
    transitions: [],
    published: [],
    logs: [],
    terminated: [],
    cleaned: [],
    readopted: [],
    launched: [],
    runs: options.runs ?? [],
    reset: () => {
      recorder.transitions.length = 0;
      recorder.published.length = 0;
      recorder.logs.length = 0;
      recorder.terminated.length = 0;
      recorder.cleaned.length = 0;
      recorder.readopted.length = 0;
      recorder.launched.length = 0;
    },
  };
  const result = await runCommandServiceEffect(
    rootPath,
    (service) =>
      Effect.gen(function* () {
        const internalEvents = yield* InternalEvents;
        return yield* body({ service, internalEvents, recorder });
      }),
    {
      ...options,
      logger: recordingLogger(recorder.logs),
      eventBus: recordingEventBus(recorder.published),
      runs: recorder.runs,
      onTransition: (input) => {
        recorder.transitions.push(input);
        options.onTransition?.(input);
      },
      onReadopt: (input) => {
        recorder.readopted.push(input);
        options.onReadopt?.(input);
      },
      pty: {
        ...options.pty,
        terminate: (input) =>
          Effect.suspend(() => {
            recorder.terminated.push(input.ptyProcessId);
            return options.pty?.terminate
              ? options.pty.terminate(input)
              : Effect.succeed('terminated_live' as const);
          }),
        cleanupProcess: (input) =>
          Effect.suspend(() => {
            recorder.cleaned.push({
              ptyProcessId: input.ptyProcessId,
              reason: input.reason,
              ensureBackendAbsence: input.ensureBackendAbsence ?? false,
            });
            return options.pty?.cleanupProcess
              ? options.pty.cleanupProcess(input)
              : Effect.succeed('already_terminal' as const);
          }),
        allocateLaunch: (input) =>
          Effect.suspend(() => {
            recorder.launched.push(input.args.at(-1) ?? input.command);
            return options.pty?.allocateLaunch
              ? options.pty.allocateLaunch(input)
              : Effect.succeed(commandLaunchAllocation({ ptyProcessId: 902, cwd: input.cwd }));
          }),
      },
    },
  );
  return { result, recorder };
}

/**
 * Waits until a runtime log line appears. It proves exactly one thing: the
 * serial lifecycle pass reached the named terminal log. It is not a claim that
 * the runtime is quiescent, and the timeout is test diagnostics — nothing in the
 * runtime falls back after it.
 */
export function waitForLog(recorder: CommandScenarioRecorder, fragment: string) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < scenarioPollLimit; attempt += 1) {
      if (recorder.logs.some((line) => line.includes(fragment))) return;
      yield* scenarioTick();
    }
    throw new Error(
      `Timed out waiting for a log line containing "${fragment}". Saw:\n${recorder.logs.join('\n')}`,
    );
  });
}

// Five seconds of headroom: the launch-gate scenarios write config files and
// run a full launch inside this budget, and CI machines are not idle.
const scenarioPollLimit = 1_000;

/**
 * A public event bus whose `publish` records synchronously into the caller's
 * array. Nothing is queued and nothing is forked, so an assertion that *no*
 * event was published is conclusive the moment the code under test returns —
 * which a drained subscription could never guarantee. Real bus transport is
 * covered by `runtime-events/api.test.ts`; these suites verify the service's
 * publication calls and their ordering.
 */
export function recordingEventBus(
  published: Array<{ readonly commandName: string; readonly status: string }>,
) {
  // `subscribe` is unimplemented: the recording bus has no subscribers.
  return Layer.mock(RuntimeEvents)({
    publish: (event) =>
      Effect.sync(() => {
        if (event.type === 'command_changed') {
          published.push({
            commandName: event.payload.commandName,
            status: event.payload.status,
          });
        }
      }),
  });
}

function scenarioTick() {
  return Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)));
}

/**
 * A logger that renders each Effect log line as `<level> <message> <key>=<value>…`
 * (annotations in the order they were added, then a cause if one was attached)
 * into `lines`. It replaces the default loggers, so nothing is printed.
 */
export function recordingLogger(lines: string[]) {
  return Logger.layer([
    Logger.make(({ logLevel, message, cause, fiber }) => {
      const text = (Array.isArray(message) ? message : [message]).map(String).join(' ');
      const annotations = Object.entries(fiber.getRef(References.CurrentLogAnnotations)).map(
        ([key, value]) => `${key}=${String(value)}`,
      );
      const parts = [logLevel.toLowerCase(), text, ...annotations];
      if (cause.reasons.length > 0) parts.push(Cause.pretty(cause));
      lines.push(parts.join(' '));
    }),
  ]);
}

// Mirrors `distinctCommandPtyLinks` in the real repository: the distinct union
// of state pointers and run links, keyed by incarnation so the ordinary
// pointer-equals-link case yields exactly one candidate.
function fakeCommandPtyLinks(
  states: readonly CommandStateRow[],
  runs: readonly CommandRunRow[],
): CommandPtyLink[] {
  const seen = new Map<string, CommandPtyLink>();
  for (const source of [
    states.map((state) => ({
      worktreeId: state.worktreeId,
      commandName: state.commandName,
      ptyProcessId: state.activePtyProcessId,
    })),
    runs.map((run) => ({
      worktreeId: run.worktreeId,
      commandName: run.commandName,
      ptyProcessId: run.ptyProcessId,
    })),
  ]) {
    for (const row of source) {
      if (row.ptyProcessId === null) continue;
      seen.set(`${row.worktreeId}:${row.commandName}:${row.ptyProcessId}`, {
        worktreeId: row.worktreeId,
        commandName: row.commandName,
        ptyProcessId: row.ptyProcessId,
      });
    }
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Port probe test support
// ---------------------------------------------------------------------------

export interface CommandPortProbeCalls {
  // Ports offered to `probeInactive`, in order. A resolver test proves a
  // fixed-only command never touched the probe by asserting this stayed empty.
  readonly probed: number[];
  // Counted rather than recorded: an OS assignment carries no input, so the
  // only fact worth pinning is how many times policy asked.
  readonly assignments: () => number;
}

/** A Node system error, the shape the loopback adapter's bind failures carry as their cause. */
export function systemError(code: string) {
  return Object.assign(new Error(`listen ${code}: 127.0.0.1`), { code });
}

/**
 * A `LoopbackPortProbe` that answers from the test's script and records
 * what policy asked of it.
 *
 * Defaults are the boring case: nothing is reusable, and every fresh assignment
 * hands back a distinct increasing port. A test overrides only the axis it is
 * about.
 */
export function commandPortProbe(
  overrides: {
    // Keyed by port so a test can say "51824 is inactive, everything else is
    // busy" without writing a predicate.
    readonly inactive?: readonly number[] | undefined;
    // Consumed in order; running past the end is a test authoring error rather
    // than a silent fallback to the default sequence.
    readonly assign?: readonly number[] | undefined;
    readonly probeFault?: ((port: number) => boolean) | undefined;
    // The adapter's structured cause (see `systemError`); the resolver renders it.
    readonly assignFailure?: Error | undefined;
  } = {},
): { readonly service: LoopbackPortProbe['Service']; readonly calls: CommandPortProbeCalls } {
  const probed: number[] = [];
  let assignments = 0;
  const inactive = new Set(overrides.inactive ?? []);
  const assign = [...(overrides.assign ?? [])];

  const service: LoopbackPortProbe['Service'] = {
    probeInactive: (port) =>
      Effect.sync(() => {
        probed.push(port);
        // The live adapter folds its own faults to `false`; a stub that models
        // a fault therefore models it as `false`, not as a raised error.
        if (overrides.probeFault?.(port)) return false;
        return inactive.has(port);
      }),
    obtainEphemeralPort: Effect.suspend(() => {
      assignments += 1;
      if (overrides.assignFailure !== undefined) {
        return Effect.fail(new LoopbackPortUnavailable({ cause: overrides.assignFailure }));
      }
      if (overrides.assign === undefined) return Effect.succeed(40_000 + assignments);
      const next = assign.shift();
      if (next === undefined) {
        throw new Error('commandPortProbe: the scripted assignment sequence was exhausted.');
      }
      return Effect.succeed(next);
    }),
  };

  return { service, calls: { probed, assignments: () => assignments } };
}

/**
 * The service-harness default: a probe that cannot be used, only caught using.
 *
 * `commandPortProbe` is permissive because a resolver test is *about* the
 * probe's answers. A launch test is not: almost every one of them drives a
 * command that declares no ports, and for those the correct observation is that
 * the launch never reached a socket at all. Dying makes that a property of the
 * whole suite instead of an assertion each test has to remember to write.
 *
 * The messages are method-specific so an accidental call says which half of the
 * policy ran — a remembered-port probe, or a fresh assignment.
 */
function untouchableCommandPortProbe(): LoopbackPortProbe['Service'] {
  return {
    probeInactive: (port) =>
      Effect.die(
        new Error(
          `The port probe was asked whether ${port} is inactive, but this test provided no \`portProbe\`. A launch that resolves allocated ports must supply one.`,
        ),
      ),
    obtainEphemeralPort: Effect.die(
      new Error(
        'The port probe was asked for a fresh ephemeral port, but this test provided no `portProbe`. A launch that resolves allocated ports must supply one.',
      ),
    ),
  };
}
