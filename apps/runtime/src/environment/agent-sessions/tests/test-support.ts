import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Effect, Layer } from 'effect';

import type { AgentHarness } from '@isagi/contracts';

import {
  makeFakeFluidcastSessions,
  type FakeFluidcastSessions,
} from '../../../fluidcast/testing.js';
import {
  AgentSessionArtifacts,
  HarnessObservationTargets,
  sdkIncarnation,
} from '../../../harnesses/index.js';
import { HarnessLedgerObserverWithInternalsLayerNoDeps } from '../../../harnesses/testing.js';
import { InternalEvents } from '../../../platform/events/index.js';
import {
  DataDirectory,
  RuntimeDatabase,
  type RuntimeDrizzleDatabase,
} from '../../../platform/persistence/index.js';
import { makeTestDataDirectory } from '../../../platform/persistence/testing.js';
import { projects, worktrees } from '../../../projects/tables.js';
import { PtyForegroundState } from '../../../pty-processes/index.js';
import type { PtyProcessRow } from '../../../pty-processes/index.js';
import { ptyProcesses } from '../../../pty-processes/tables.js';
import type { AgentSessionRow, TerminalSessionRow } from '../../sessions/types.js';
import { agentSessions } from '../../tables.js';
import { AgentSessionAttentionProjection } from '../attention.js';
import { AgentSessionInteraction } from '../interaction.js';
import { HarnessObservationTargetsLayerNoDeps } from '../observation-targets.js';

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
  return RuntimeDatabase.layer.pipe(Layer.provide(dataDirectoryLayer(dataRoot)));
}

/**
 * The observer stack over a test data root, with the real targets layer over one interaction.
 * `targets` replaces the environment's observation targets with a stub. `fluidcast` is the fake
 * behind the interaction (disabled by default); seed Fluidcast mode with `seedFluidcastMode`.
 */
export function testLayer(
  dataRoot: string,
  options: {
    readonly targets?: Layer.Layer<HarnessObservationTargets>;
    readonly fluidcast?: FakeFluidcastSessions;
  } = {},
) {
  const directoryLayer = dataDirectoryLayer(dataRoot);
  const database = RuntimeDatabase.layer.pipe(Layer.provide(directoryLayer));
  const artifacts = AgentSessionArtifacts.layer.pipe(Layer.provide(directoryLayer));
  const internalBus = InternalEvents.layer;
  const foreground = PtyForegroundState.layer;
  const fluidcast = (options.fluidcast ?? makeFakeFluidcastSessions({ availability: 'disabled' }))
    .layer;
  const interaction = AgentSessionInteraction.layerNoDeps.pipe(Layer.provide(fluidcast));
  const observer = HarnessLedgerObserverWithInternalsLayerNoDeps.pipe(
    Layer.provide(directoryLayer),
    Layer.provide(
      options.targets ??
        HarnessObservationTargetsLayerNoDeps.pipe(
          Layer.provide(database),
          Layer.provide(interaction),
        ),
    ),
    Layer.provide(artifacts),
    Layer.provide(internalBus),
  );
  const attention = AgentSessionAttentionProjection.layerNoDeps.pipe(
    Layer.provide(database),
    Layer.provide(artifacts),
    Layer.provide(foreground),
    Layer.provide(observer),
    Layer.provide(interaction),
  );
  return Layer.mergeAll(
    attention,
    observer,
    artifacts,
    foreground,
    internalBus,
    database,
    interaction,
    fluidcast,
  );
}

/**
 * Puts an agent in Fluidcast mode the way a switch records it: starts a fake session, sets the
 * interaction and publishes the `switched` interval, without the switch's admission or cleanup.
 * The observer handles the event asynchronously; wait for its `agent_session_changed`.
 */
export const seedFluidcastMode = Effect.fnUntraced(function* (
  fluidcast: FakeFluidcastSessions,
  input: {
    readonly agentSessionId: number;
    readonly harness: Extract<AgentHarness, 'claude' | 'codex'>;
    readonly harnessSessionId: string | null;
  },
) {
  const interaction = yield* AgentSessionInteraction;
  const bus = yield* InternalEvents;
  const started = yield* fluidcast.service.start({ ...input, cwd: '/repo/isagi' });
  interaction.setFluidcast(input.agentSessionId, started);
  yield* bus.publish({
    type: 'agent_session_execution_changed',
    agentSessionId: input.agentSessionId,
    change: {
      _tag: 'switched',
      interval: { incarnation: sdkIncarnation(started.fluidcastSessionId), since: started.since },
    },
  });
  return started;
});

function dataDirectoryLayer(dataRoot: string) {
  return Layer.succeed(DataDirectory, makeTestDataDirectory(dataRoot));
}

// Ledger and timing helpers for execution-keyed observation (PTY and SDK records).

export const base = Date.UTC(2026, 6, 9);

export type ExecutionMark = { readonly pty: number | null; readonly sdk: string | null };

export function ptyMark(ptyProcessId: number): ExecutionMark {
  return { pty: ptyProcessId, sdk: null };
}

export function prepareAgent(
  root: string,
  ledgerSessionId: string,
  metadataSessionId: string | null = ledgerSessionId,
  agentSessionId = 10,
) {
  const directory = join(root, 'sessions', 'agent-sessions', String(agentSessionId));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(directory, 'harness.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      harnessSessionId: metadataSessionId,
      updatedAt: at(0),
    })}\n`,
    { mode: 0o600 },
  );
  const path = join(directory, `${Buffer.from(ledgerSessionId).toString('hex')}.harness.jsonl`);
  writeFileSync(path, '', { mode: 0o600 });
  return path;
}

export function hookRecord(
  harness: AgentHarness,
  harnessSessionId: string,
  nativeEvent: string,
  seconds: number,
  mark: ExecutionMark,
  event: Record<string, unknown> = {},
  agentSessionId = 10,
  origin = base,
) {
  return `${JSON.stringify({
    schemaVersion: 1,
    recordedAt: at(seconds, origin),
    agentSessionId,
    harnessSessionId,
    ptyProcessId: mark.pty,
    sdkExecutionId: mark.sdk,
    harness,
    nativeEvent,
    event: { session_id: harnessSessionId, hook_event_name: nativeEvent, ...event },
  })}\n`;
}

export function rolloutLines(
  entries: readonly (readonly [type: string, seconds: number, payload: unknown])[],
  origin = base,
) {
  return entries
    .map(
      ([type, seconds, payload]) =>
        `${JSON.stringify({ type, timestamp: at(seconds, origin), payload })}\n`,
    )
    .join('');
}

export function edgeSummary(
  edges: readonly {
    readonly type: string;
    readonly seq: number | null;
    readonly reason?: string;
  }[],
) {
  return edges.map((edge) => [edge.type, edge.seq, edge.reason ?? null]);
}

export function at(seconds: number, origin = base) {
  return new Date(origin + seconds * 1000).toISOString();
}

export function sdkExecutionMark(executionId: string): ExecutionMark {
  return { pty: null, sdk: executionId };
}
