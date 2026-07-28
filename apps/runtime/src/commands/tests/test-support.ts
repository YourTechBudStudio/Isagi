import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import websocket from '@fastify/websocket';
import { Effect, Layer, ManagedRuntime } from 'effect';
import Fastify from 'fastify';

import { DataDirectory } from '../../persistence/index.js';
import { makeTestDataDirectory } from '../../persistence/test-support.js';
import {
  PtyRepository,
  PtyService,
  type PtyRepositoryService,
  type PtyServiceShape,
} from '../../pty-processes/index.js';
import type { PtyAttachment } from '../../pty-processes/pty.service.js';
import {
  InternalRuntimeEventBusLive,
  RuntimeEventBusLive,
  type InternalRuntimeEventBusService,
} from '../../runtime-events/index.js';
import { WorkspaceRepository, type WorkspaceRepositoryService } from '../../workspace/index.js';
import { registerCommandsApi } from '../api.js';
import {
  CommandRepository,
  type CommandRepositoryService,
  type CommandRunRow,
  type CommandStateRow,
} from '../commands.repository.js';
import {
  CommandService,
  CommandServiceLive,
  type CommandService as CommandServiceShape,
} from '../commands.service.js';

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

export async function withCommandsApi<A>(
  service: CommandServiceShape,
  run: (fastify: Fastify.FastifyInstance) => Promise<A>,
  options: { readonly pty?: PtyServiceShape | undefined } = {},
) {
  const fastify = Fastify({ logger: false });
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(CommandService, service),
      Layer.succeed(PtyService, options.pty ?? fakeCommandLogPtyService()),
    ),
  );
  try {
    await fastify.register(websocket);
    registerCommandsApi(fastify, runtime as never);
    await fastify.ready();
    return await run(fastify);
  } finally {
    await fastify.close();
    await runtime.dispose();
  }
}

export function commandService(overrides: Partial<CommandServiceShape> = {}): CommandServiceShape {
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
    reconcileStaleRunningCommands: Effect.void,
    ...overrides,
  };
}

export function delayedSucceed<A>(value: A) {
  return Effect.sleep(1).pipe(Effect.as(value));
}

export function fakeCommandLogPtyService(
  overrides: Partial<PtyServiceShape> = {},
): PtyServiceShape {
  return {
    launch: () => Effect.die('launch is not used'),
    getAttachmentPlan: () =>
      Effect.succeed({
        session: fakePtyProcess(),
        replayBytes: 0,
        live: true,
        replaySource: 'file_log',
      }),
    attach: () => Effect.die('attach is not used'),
    replay: () => Effect.void,
    write: () => Effect.die('write is not used'),
    writeInput: () => Effect.die('writeInput is not used'),
    resize: () => Effect.die('resize is not used'),
    kill: () => Effect.die('kill is not used'),
    terminate: () => Effect.die('terminate is not used'),
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
    unsubscribe: () => {},
    ...overrides,
  };
}

export function fakePtyProcess(
  overrides: Partial<Parameters<PtyServiceShape['replay']>[0]['session']> = {},
): Parameters<PtyServiceShape['replay']>[0]['session'] {
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
  readonly pty?: Partial<PtyServiceShape> | undefined;
  readonly onTransition?:
    | ((input: {
        readonly commandName: string;
        readonly status: CommandStateRow['status'];
      }) => void)
    | undefined;
}

export async function runCommandService(rootPath: string, options: CommandRepositoryOptions = {}) {
  return runCommandServiceEffect(rootPath, (service) => service.listForWorktree(10), options);
}

export async function runCommandServiceEffect<A>(
  rootPath: string,
  effect: (
    service: import('../commands.service.js').CommandService,
  ) => Effect.Effect<
    A,
    unknown,
    import('../commands.service.js').CommandService | InternalRuntimeEventBusService
  >,
  options: CommandRepositoryOptions = {},
) {
  return Effect.runPromise(
    CommandService.pipe(
      Effect.flatMap(effect),
      Effect.provide(CommandServiceLive),
      Effect.provide(Layer.succeed(WorkspaceRepository, repository(rootPath))),
      Effect.provide(Layer.succeed(CommandRepository, commandRepository(options))),
      Effect.provide(Layer.succeed(PtyRepository, ptyRepository())),
      Effect.provide(Layer.succeed(PtyService, ptyService(options.pty))),
      Effect.provide(Layer.succeed(DataDirectory, makeTestDataDirectory(rootPath))),
      Effect.provide(RuntimeEventBusLive),
      Effect.provide(InternalRuntimeEventBusLive),
    ),
  );
}

export function commandRepository(
  options: CommandRepositoryOptions = {},
): CommandRepositoryService {
  const states = [...(options.states ?? [])];
  const runs = options.runs ?? [];
  return {
    listStatesForWorktree: (worktreeId) =>
      Effect.succeed(states.filter((state) => state.worktreeId === worktreeId)),
    findState: (input) =>
      Effect.succeed(
        states.find(
          (state) =>
            state.worktreeId === input.worktreeId && state.commandName === input.commandName,
        ) ?? null,
      ),
    listRunningStates: Effect.succeed([...(options.runningStates ?? [])]),
    listRunningStatesForWorktree: (worktreeId) =>
      Effect.succeed(
        (options.runningStates ?? []).filter((state) => state.worktreeId === worktreeId),
      ),
    ensureState: () => Effect.die('ensureState is not used'),
    transitionState: (input) =>
      Effect.sync(() => {
        options.onTransition?.({ commandName: input.commandName, status: input.status });
        const existing = states.find(
          (state) =>
            state.worktreeId === input.worktreeId && state.commandName === input.commandName,
        );
        const next = {
          ...(existing ?? commandState({ commandName: input.commandName, status: input.status })),
          status: input.status,
          activePtyProcessId: input.activePtyProcessId ?? null,
        };
        if (existing) {
          states.splice(states.indexOf(existing), 1, next);
        } else {
          states.push(next);
        }
        return next;
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
      Effect.sync(() => {
        const run = runs.find((candidate) => candidate.id === input.runId);
        if (!run) return options.latestRun ?? null;
        const updated = { ...run, ptyProcessId: input.ptyProcessId };
        runs.splice(runs.indexOf(run), 1, updated);
        return updated;
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
    completeRunByPtyProcess: (input) =>
      Effect.sync(() => {
        const run = runs.find((candidate) => candidate.ptyProcessId === input.ptyProcessId);
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
      Effect.sync(() => {
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
      }),
    listReferencedPtyProcessIds: Effect.succeed([]),
  };
}

export function commandState(input: {
  readonly commandName: string;
  readonly status: CommandStateRow['status'];
}): CommandStateRow {
  return {
    id: 1,
    worktreeId: 10,
    commandName: input.commandName,
    status: input.status,
    activePtyProcessId: input.status === 'running' ? 123 : null,
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
}): CommandRunRow {
  return {
    id: 1,
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

export function ptyRepository(): PtyRepositoryService {
  return {
    createProcessMetadata: () => Effect.die('createProcessMetadata is not used'),
    findProcess: () => Effect.succeed(null),
    listProcessLogPaths: Effect.succeed([]),
    listOrphanProcesses: Effect.succeed([]),
    listProcesses: () => Effect.succeed([]),
    deleteProcess: () => Effect.void,
    updateBackendRef: () => Effect.void,
    updateBackendMetadata: () => Effect.void,
    transitionProcess: () => Effect.void,
  };
}

export function ptyService(overrides: Partial<PtyServiceShape> = {}): PtyServiceShape {
  return {
    launch: overrides.launch ?? (() => Effect.die('launch is not used')),
    getAttachmentPlan: () => Effect.die('getAttachmentPlan is not used'),
    attach: () => Effect.die('attach is not used'),
    replay: () => Effect.void,
    write: () => Effect.void,
    writeInput: () => Effect.void,
    resize: () => Effect.void,
    kill: () => Effect.void,
    terminate: overrides.terminate ?? (() => Effect.void),
    pin: overrides.pin ?? (() => Effect.void),
    unpin: overrides.unpin ?? (() => Effect.void),
    isPinned: overrides.isPinned ?? (() => Effect.succeed(false)),
  };
}

export function repository(rootPath: string): WorkspaceRepositoryService {
  return {
    listDurableSessions: Effect.succeed({ sessions: [] }),
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
    deleteProject: () => Effect.succeed(false),
    deleteWorktree: () => Effect.succeed(false),
    readWorktreeDeleteDiagnostics: () =>
      Effect.succeed({
        agentSessionCount: 0,
        agentSessionActivePtyProcessIds: [],
        commandRunCount: 0,
        commandRunPtyProcessIds: [],
        commandStateCount: 0,
        commandStateActivePtyProcessIds: [],
        paneCount: 0,
        surfaceCount: 0,
        terminalSessionCount: 0,
        terminalSessionActivePtyProcessIds: [],
      }),
    insertProject: () => Effect.succeed(1),
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
