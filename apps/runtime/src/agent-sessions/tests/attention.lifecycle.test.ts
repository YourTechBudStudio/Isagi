import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import { RuntimeDatabase } from '../../persistence/index.js';
import {
  agentSessions,
  ptyProcesses,
  surfacePanes,
  terminalSessions,
  worktreeSurfaces,
} from '../../persistence/schema.js';
import { PtyForegroundState } from '../../pty-processes/index.js';
import { AgentSessionAttentionProjection } from '../attention-projection.service.js';
import {
  agentSession,
  appendRecord,
  harnessLogPath,
  ptyProcess,
  seedActiveAgentSession,
  seedRuntimeDatabase,
  terminalSession,
  testLayer,
  writeHarnessObservation,
} from './test-support.js';

test('agent attention is idle when cleanly exited and error when the process is missing or failed', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-attention-working-dead-'));
  try {
    const states = await Effect.runPromise(
      Effect.gen(function* () {
        const attention = yield* AgentSessionAttentionProjection;
        const exited = yield* attention.agentSessionAttention(
          agentSession({ activePtyProcess: ptyProcess({ id: 20, status: 'exited' }) }),
        );
        const missing = yield* attention.agentSessionAttention(
          agentSession({ activePtyProcessId: 20, activePtyProcess: null }),
        );
        const failed = yield* attention.agentSessionAttention(
          agentSession({ activePtyProcess: ptyProcess({ id: 20, status: 'failed' }) }),
        );
        return { exited, missing, failed };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(states, { exited: 'idle', missing: 'error', failed: 'error' });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('agent attention ignores last-known waiting once the process is gone', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-attention-waiting-dead-'));
  try {
    const states = await Effect.runPromise(
      Effect.gen(function* () {
        const attention = yield* AgentSessionAttentionProjection;
        const exited = yield* attention.agentSessionAttention(
          agentSession({ activePtyProcess: ptyProcess({ id: 20, status: 'exited' }) }),
        );
        const missing = yield* attention.agentSessionAttention(
          agentSession({ activePtyProcessId: 20, activePtyProcess: null }),
        );
        const failed = yield* attention.agentSessionAttention(
          agentSession({ activePtyProcess: ptyProcess({ id: 20, status: 'failed' }) }),
        );
        return { exited, missing, failed };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(states, { exited: 'idle', missing: 'error', failed: 'error' });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('agent attention treats only deliberate kill reasons as idle, all others as error', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-attention-killed-'));
  try {
    const states = await Effect.runPromise(
      Effect.gen(function* () {
        const attention = yield* AgentSessionAttentionProjection;
        const killedByUser = yield* attention.agentSessionAttention(
          agentSession({
            activePtyProcess: ptyProcess({
              id: 20,
              status: 'killed',
              statusReason: 'user_requested',
            }),
          }),
        );
        const killedByShutdown = yield* attention.agentSessionAttention(
          agentSession({
            activePtyProcess: ptyProcess({
              id: 20,
              status: 'killed',
              statusReason: 'runtime_shutdown',
            }),
          }),
        );
        const killedByFailure = yield* attention.agentSessionAttention(
          agentSession({
            activePtyProcess: ptyProcess({
              id: 20,
              status: 'killed',
              statusReason: 'backend_process_missing',
            }),
          }),
        );
        const killedWithoutReason = yield* attention.agentSessionAttention(
          agentSession({
            activePtyProcess: ptyProcess({ id: 20, status: 'killed', statusReason: null }),
          }),
        );

        // A non-benign kill is an error even when the last-observed harness state
        // was waiting — a dead process is never "waiting on you".
        const failureKillStaysError = yield* attention.agentSessionAttention(
          agentSession({
            activePtyProcess: ptyProcess({
              id: 20,
              status: 'killed',
              statusReason: 'backend_process_missing',
            }),
          }),
        );

        return {
          killedByUser,
          killedByShutdown,
          killedByFailure,
          killedWithoutReason,
          failureKillStaysError,
        };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(states, {
      killedByUser: 'idle',
      killedByShutdown: 'idle',
      killedByFailure: 'error',
      killedWithoutReason: 'error',
      failureKillStaysError: 'error',
    });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('terminal attention treats only deliberate kill reasons as idle, all others as error', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-attention-terminal-killed-'));
  try {
    const states = await Effect.runPromise(
      Effect.gen(function* () {
        const attention = yield* AgentSessionAttentionProjection;
        return {
          killedByUser: attention.terminalSessionAttention(
            terminalSession({
              activePtyProcess: ptyProcess({
                id: 30,
                status: 'killed',
                statusReason: 'user_requested',
              }),
            }),
          ),
          killedByFailure: attention.terminalSessionAttention(
            terminalSession({
              activePtyProcess: ptyProcess({
                id: 30,
                status: 'killed',
                statusReason: 'runtime_ephemeral_lost',
              }),
            }),
          ),
          killedWithoutReason: attention.terminalSessionAttention(
            terminalSession({
              activePtyProcess: ptyProcess({ id: 30, status: 'killed', statusReason: null }),
            }),
          ),
        };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(states, {
      killedByUser: 'idle',
      killedByFailure: 'error',
      killedWithoutReason: 'error',
    });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('startup attention reads pre-existing harness logs before applying process lifecycle', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-attention-startup-overlay-'));
  try {
    await seedActiveAgentSession(dataRoot);
    const directory = join(dataRoot, 'sessions', 'agent-sessions', '10');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(directory, 'harness.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        harnessSessionId: 'pi-session-1',
        updatedAt: '2026-07-09T00:00:00.000Z',
      })}\n`,
      { mode: 0o600 },
    );
    appendRecord(harnessLogPath(directory), 'agent_start', null);
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const attention = yield* AgentSessionAttentionProjection;
        return yield* attention.agentSessionAttention(
          agentSession({ activePtyProcess: ptyProcess({ id: 20, status: 'running' }) }),
        );
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(state, 'working');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('terminal attention derives from PTY lifecycle', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-attention-terminal-'));
  try {
    const states = await Effect.runPromise(
      Effect.gen(function* () {
        const attention = yield* AgentSessionAttentionProjection;
        const foreground = yield* PtyForegroundState;
        yield* foreground.set(30, 'working');
        return {
          runningForeground: attention.terminalSessionAttention(
            terminalSession({ activePtyProcess: ptyProcess({ id: 30, status: 'running' }) }),
          ),
          runningPromptReady: attention.terminalSessionAttention(
            terminalSession({ activePtyProcess: ptyProcess({ id: 31, status: 'running' }) }),
          ),
          exited: attention.terminalSessionAttention(
            terminalSession({ activePtyProcess: ptyProcess({ id: 30, status: 'exited' }) }),
          ),
          failed: attention.terminalSessionAttention(
            terminalSession({ activePtyProcess: ptyProcess({ id: 30, status: 'failed' }) }),
          ),
        };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(states, {
      runningForeground: 'working',
      runningPromptReady: 'idle',
      exited: 'idle',
      failed: 'error',
    });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

const fixtureTime = '2026-06-18T00:00:00.000Z';

type PtyProcessInsert = typeof ptyProcesses.$inferInsert;

function seedPtyProcess(options: {
  readonly id: number;
  readonly status: PtyProcessInsert['status'];
  readonly statusReason?: PtyProcessInsert['statusReason'];
  readonly command?: string;
}): PtyProcessInsert {
  return {
    id: options.id,
    backend: 'node_pty',
    backendRefJson: '{}',
    command: options.command ?? 'pi',
    argsJson: '[]',
    cwd: '/repo/isagi',
    status: options.status,
    statusReason: options.statusReason ?? null,
    exitCode: null,
    signal: null,
    logMode: 'none',
    logPath: null,
    createdAt: fixtureTime,
    updatedAt: fixtureTime,
    exitedAt: null,
    lastSeenAt: null,
  };
}

function seedAgentSession(options: {
  readonly id: number;
  readonly activePtyProcessId: number;
}): typeof agentSessions.$inferInsert {
  return {
    id: options.id,
    worktreeId: 1,
    harness: 'pi',
    cwd: '/repo/isagi',
    activePtyProcessId: options.activePtyProcessId,
    createdAt: fixtureTime,
    updatedAt: fixtureTime,
    lastSeenAt: fixtureTime,
  };
}

function readWorkingAgentCount(dataRoot: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const attention = yield* AgentSessionAttentionProjection;
      return yield* attention.workingAgentCount;
    }).pipe(Effect.provide(testLayer(dataRoot))),
  );
}

test('working agent count counts only genuinely working agents across the attention matrix', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-attention-count-matrix-'));
  try {
    // Session 10 (running + agent_start) is the only working agent. The rest
    // cover every other Phase 4 outcome: waiting, deliberately stopped,
    // degraded attention, and a working terminal that is not an agent at all.
    await seedActiveAgentSession(dataRoot);
    await seedRuntimeDatabase(dataRoot, (db) => {
      db.insert(ptyProcesses)
        .values([
          seedPtyProcess({ id: 21, status: 'running' }),
          seedPtyProcess({ id: 22, status: 'killed', statusReason: 'user_requested' }),
          seedPtyProcess({ id: 23, status: 'running' }),
          seedPtyProcess({ id: 30, status: 'running', command: 'bash' }),
        ])
        .run();
      db.insert(agentSessions)
        .values([
          seedAgentSession({ id: 11, activePtyProcessId: 21 }),
          seedAgentSession({ id: 12, activePtyProcessId: 22 }),
          seedAgentSession({ id: 13, activePtyProcessId: 23 }),
        ])
        .run();
      db.insert(terminalSessions)
        .values({
          id: 30,
          worktreeId: 1,
          cwd: '/repo/isagi',
          shellCommand: 'bash',
          shellArgsJson: '[]',
          activePtyProcessId: 30,
          createdAt: fixtureTime,
          updatedAt: fixtureTime,
        })
        .run();
    });
    writeHarnessObservation(dataRoot, {
      agentSessionId: 10,
      harnessSessionId: 'pi-session-1',
      ptyProcessId: 20,
      nativeEvent: 'agent_start',
      pending: null,
    });
    writeHarnessObservation(dataRoot, {
      agentSessionId: 11,
      harnessSessionId: 'pi-session-2',
      ptyProcessId: 21,
      nativeEvent: 'agent_end',
      pending: false,
    });
    writeHarnessObservation(dataRoot, {
      agentSessionId: 12,
      harnessSessionId: 'pi-session-3',
      ptyProcessId: 22,
      nativeEvent: 'agent_start',
      pending: null,
    });
    // Session 13 keeps no harness metadata: attention degrades to `error`, and a
    // degraded agent is never counted as working.

    assert.equal(await readWorkingAgentCount(dataRoot), 1);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('working agent count is zero without working agents and aggregates every working one', async () => {
  const idle = mkdtempSync(join(tmpdir(), 'isagi-attention-count-zero-'));
  const many = mkdtempSync(join(tmpdir(), 'isagi-attention-count-many-'));
  try {
    // Sessions exist and one is live: the count is zero because none of them is
    // working, not because there is nothing to count.
    await seedActiveAgentSession(idle);
    await seedRuntimeDatabase(idle, (db) => {
      db.insert(ptyProcesses)
        .values([seedPtyProcess({ id: 21, status: 'running' })])
        .run();
      db.insert(agentSessions)
        .values([seedAgentSession({ id: 11, activePtyProcessId: 21 })])
        .run();
    });
    writeHarnessObservation(idle, {
      agentSessionId: 10,
      harnessSessionId: 'pi-session-1',
      ptyProcessId: 20,
      nativeEvent: 'agent_end',
      pending: false,
    });
    assert.equal(await readWorkingAgentCount(idle), 0);

    await seedActiveAgentSession(many);
    await seedRuntimeDatabase(many, (db) => {
      db.insert(ptyProcesses)
        .values([seedPtyProcess({ id: 21, status: 'running' })])
        .run();
      db.insert(agentSessions)
        .values([seedAgentSession({ id: 11, activePtyProcessId: 21 })])
        .run();
    });
    writeHarnessObservation(many, {
      agentSessionId: 10,
      harnessSessionId: 'pi-session-1',
      ptyProcessId: 20,
      nativeEvent: 'agent_start',
      pending: null,
    });
    // A turn that ended with queued messages is still working, not waiting.
    writeHarnessObservation(many, {
      agentSessionId: 11,
      harnessSessionId: 'pi-session-2',
      ptyProcessId: 21,
      nativeEvent: 'agent_end',
      pending: true,
    });

    assert.equal(await readWorkingAgentCount(many), 2);
  } finally {
    rmSync(idle, { recursive: true, force: true });
    rmSync(many, { recursive: true, force: true });
  }
});

test('working agent count uses each durable agent once, independent of panes and terminals', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-attention-working-count-'));
  try {
    await seedActiveAgentSession(dataRoot);
    const directory = join(dataRoot, 'sessions', 'agent-sessions', '10');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(directory, 'harness.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        harnessSessionId: 'pi-session-1',
        updatedAt: '2026-07-09T00:00:00.000Z',
      })}\n`,
      { mode: 0o600 },
    );
    appendRecord(harnessLogPath(directory), 'agent_start', null);
    const paneLessDirectory = join(dataRoot, 'sessions', 'agent-sessions', '11');
    mkdirSync(paneLessDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(paneLessDirectory, 'harness.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        harnessSessionId: 'pi-session-2',
        updatedAt: '2026-07-09T00:00:00.000Z',
      })}\n`,
      { mode: 0o600 },
    );
    appendRecord(harnessLogPath(paneLessDirectory, 'pi-session-2'), 'agent_start', null, {
      agentSessionId: 11,
      harnessSessionId: 'pi-session-2',
      ptyProcessId: 21,
    });

    const count = await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* RuntimeDatabase;
        yield* database.use('seed_attention_presentation_duplicates', (db) => {
          const now = '2026-06-18T00:00:00.000Z';
          db.insert(worktreeSurfaces)
            .values({
              id: 40,
              worktreeId: 1,
              title: 'Surface',
              layoutJson: '{}',
              sortOrder: 0,
              createdAt: now,
              updatedAt: now,
            })
            .run();
          db.insert(ptyProcesses)
            .values({
              id: 30,
              backend: 'node_pty',
              backendRefJson: '{}',
              command: 'bash',
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
          db.insert(ptyProcesses)
            .values({
              id: 21,
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
              id: 11,
              worktreeId: 1,
              harness: 'pi',
              cwd: '/repo/isagi',
              activePtyProcessId: 21,
              createdAt: now,
              updatedAt: now,
              lastSeenAt: now,
            })
            .run();
          db.insert(terminalSessions)
            .values({
              id: 30,
              worktreeId: 1,
              cwd: '/repo/isagi',
              shellCommand: 'bash',
              shellArgsJson: '[]',
              activePtyProcessId: 30,
              createdAt: now,
              updatedAt: now,
            })
            .run();
          db.insert(surfacePanes)
            .values([
              {
                id: 41,
                surfaceId: 40,
                title: 'Agent one',
                sortOrder: 0,
                sessionKind: 'agent_session',
                sessionId: 11,
                createdAt: now,
                updatedAt: now,
              },
              {
                id: 42,
                surfaceId: 40,
                title: 'Agent duplicate',
                sortOrder: 1,
                sessionKind: 'agent_session',
                sessionId: 11,
                createdAt: now,
                updatedAt: now,
              },
              {
                id: 43,
                surfaceId: 40,
                title: 'Working terminal',
                sortOrder: 2,
                sessionKind: 'terminal_session',
                sessionId: 30,
                createdAt: now,
                updatedAt: now,
              },
            ])
            .run();
        });
        const attention = yield* AgentSessionAttentionProjection;
        return yield* attention.workingAgentCount;
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(count, 1);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
