import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Effect, Layer } from 'effect';

import {
  DataDirectory,
  RuntimeDatabase,
  RuntimeDatabaseLive,
  type RuntimeDrizzleDatabase,
} from '../../persistence/index.js';
import { agentSessions, projects, ptyProcesses, worktrees } from '../../persistence/schema.js';
import { makeTestDataDirectory } from '../../persistence/test-support.js';
import { PtyForegroundStateLive } from '../../pty-processes/index.js';
import { InternalRuntimeEventBusLive } from '../../runtime-events/index.js';
import type { AgentSessionRow, PtyProcessRow, TerminalSessionRow } from '../../surfaces/types.js';
import { AgentSessionAttentionProjectionLive } from '../attention-projection.service.js';
import { AgentSessionArtifactsLive } from '../harness/ledger.js';
import { HarnessLedgerObserverLive } from '../harness/observer.service.js';

export function appendRecord(
  path: string,
  nativeEvent: 'agent_start' | 'agent_end',
  pending: boolean | null,
  options: {
    readonly agentSessionId?: number;
    readonly harnessSessionId?: string;
    readonly ptyProcessId?: number;
  } = {},
) {
  const agentSessionId = options.agentSessionId ?? 10;
  const harnessSessionId = options.harnessSessionId ?? 'pi-session-1';
  appendFileSync(
    path,
    `${JSON.stringify({
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      agentSessionId,
      harnessSessionId,
      ptyProcessId: options.ptyProcessId ?? 20,
      harness: 'pi',
      nativeEvent,
      event: {
        nativeEvent,
        context: { isIdle: pending === false, hasPendingMessages: pending },
      },
    })}\n`,
    'utf8',
  );
}

/** Writes the on-disk harness artifacts (metadata plus one ledger record) for an agent session. */
export function writeHarnessObservation(
  dataRoot: string,
  options: {
    readonly agentSessionId: number;
    readonly harnessSessionId: string;
    readonly ptyProcessId: number;
    readonly nativeEvent: 'agent_start' | 'agent_end';
    readonly pending: boolean | null;
  },
) {
  const directory = join(dataRoot, 'sessions', 'agent-sessions', String(options.agentSessionId));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(directory, 'harness.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      harnessSessionId: options.harnessSessionId,
      updatedAt: '2026-07-09T00:00:00.000Z',
    })}\n`,
    { mode: 0o600 },
  );
  appendRecord(
    harnessLogPath(directory, options.harnessSessionId),
    options.nativeEvent,
    options.pending,
    {
      agentSessionId: options.agentSessionId,
      harnessSessionId: options.harnessSessionId,
      ptyProcessId: options.ptyProcessId,
    },
  );
}

export function harnessLogPath(directory: string, harnessSessionId = 'pi-session-1') {
  return join(directory, `${Buffer.from(harnessSessionId, 'utf8').toString('hex')}.harness.jsonl`);
}

export function agentSession(overrides: Partial<AgentSessionRow> = {}): AgentSessionRow {
  return {
    id: 10,
    worktreeId: 1,
    harness: 'pi',
    cwd: '/repo/isagi',
    harnessSessionId: 'pi-session-1',
    harnessMetadataStatus: 'valid',
    harnessMetadataDiagnostic: null,
    activePtyProcessId: 20,
    createdAt: '2026-06-18T00:00:00.000Z',
    updatedAt: '2026-06-18T00:00:00.000Z',
    lastSeenAt: null,
    activePtyProcess: ptyProcess({ id: 20 }),
    ...overrides,
  };
}

export function terminalSession(overrides: Partial<TerminalSessionRow> = {}): TerminalSessionRow {
  return {
    id: 30,
    worktreeId: 1,
    cwd: '/repo/isagi',
    shellCommand: 'bash',
    shellArgs: [],
    shellArgsJson: '[]',
    activePtyProcessId: 30,
    createdAt: '2026-06-18T00:00:00.000Z',
    updatedAt: '2026-06-18T00:00:00.000Z',
    activePtyProcess: ptyProcess({ id: 30 }),
    ...overrides,
  };
}

export function ptyProcess(overrides: Partial<PtyProcessRow> = {}): PtyProcessRow {
  return {
    id: 20,
    backend: 'node_pty',
    backendRefJson: '{}',
    command: 'pi',
    args: [],
    argsJson: '[]',
    cwd: '/repo/isagi',
    status: 'running',
    statusReason: null,
    exitCode: null,
    signal: null,
    logMode: 'none',
    logPath: null,
    createdAt: '2026-06-18T00:00:00.000Z',
    updatedAt: '2026-06-18T00:00:00.000Z',
    exitedAt: null,
    lastSeenAt: null,
    ...overrides,
  };
}

export async function seedActiveAgentSession(
  dataRoot: string,
  harness: 'pi' | 'claude' | 'codex' | 'opencode' = 'pi',
) {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* RuntimeDatabase;
      yield* database.use('seed_attention_relevant_agent_session', (db) => {
        const now = '2026-06-18T00:00:00.000Z';
        db.insert(projects)
          .values({
            id: 1,
            name: 'Isagi',
            rootPath: '/repo/isagi',
            status: 'present',
            createdAt: now,
            updatedAt: now,
            lastSeenAt: now,
            missingReason: null,
          })
          .run();
        db.insert(worktrees)
          .values({
            id: 1,
            projectId: 1,
            path: '/repo/isagi',
            branch: 'main',
            head: null,
            createdAt: now,
            updatedAt: now,
            firstSeenAt: now,
            lastSeenAt: now,
          })
          .run();
        db.insert(ptyProcesses)
          .values({
            id: 20,
            backend: 'node_pty',
            backendRefJson: '{}',
            command: 'pi',
            argsJson: '[]',
            cwd: '/repo/isagi',
            status: 'running',
            statusReason: null,
            exitCode: null,
            signal: null,
            logMode: 'none',
            logPath: null,
            createdAt: now,
            updatedAt: now,
            exitedAt: null,
            lastSeenAt: null,
          })
          .run();
        db.insert(agentSessions)
          .values({
            id: 10,
            worktreeId: 1,
            harness,
            cwd: '/repo/isagi',
            activePtyProcessId: 20,
            createdAt: now,
            updatedAt: now,
            lastSeenAt: now,
          })
          .run();
      });
    }).pipe(Effect.provide(databaseLayer(dataRoot))),
  );
}

/**
 * Seeds durable rows before the projection layer is built, so the harness
 * observer's startup inventory actually sees them. Tests that insert rows
 * inside the projection effect are only exercising the unobserved path.
 */
export function seedRuntimeDatabase(
  dataRoot: string,
  seed: (database: RuntimeDrizzleDatabase) => void,
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* RuntimeDatabase;
      yield* database.use('seed_attention_fixture', seed);
    }).pipe(Effect.provide(databaseLayer(dataRoot))),
  );
}

function databaseLayer(dataRoot: string) {
  return RuntimeDatabaseLive.pipe(Layer.provide(dataDirectoryLayer(dataRoot)));
}

export function testLayer(dataRoot: string) {
  const directoryLayer = dataDirectoryLayer(dataRoot);
  const database = RuntimeDatabaseLive.pipe(Layer.provide(directoryLayer));
  const artifacts = AgentSessionArtifactsLive.pipe(Layer.provide(directoryLayer));
  const internalBus = InternalRuntimeEventBusLive;
  const foreground = PtyForegroundStateLive;
  const observer = HarnessLedgerObserverLive.pipe(
    Layer.provide(directoryLayer),
    Layer.provide(database),
    Layer.provide(artifacts),
    Layer.provide(internalBus),
  );
  const attention = AgentSessionAttentionProjectionLive.pipe(
    Layer.provide(database),
    Layer.provide(artifacts),
    Layer.provide(foreground),
    Layer.provide(observer),
  );
  return Layer.mergeAll(attention, observer, artifacts, foreground, internalBus, database);
}

function dataDirectoryLayer(dataRoot: string) {
  return Layer.succeed(DataDirectory, makeTestDataDirectory(dataRoot));
}
