import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { Effect, Either, Layer } from 'effect';

import type { RuntimeEvent, SurfaceDetail } from '@isagi/contracts';

import {
  DataDirectory,
  DatabaseError,
  RuntimeDatabaseLive,
  type DataDirectoryService,
} from '../persistence/index.js';
import {
  RuntimeEventBus,
  RuntimeEventBusLive,
  type RuntimeEventBusService,
} from '../runtime-events/index.js';
import {
  SurfaceRepositoryLive,
  SurfaceService,
  SurfaceServiceLive,
  type PtySessionRow,
} from '../surfaces/index.js';
import { WorkspaceRepository, WorkspaceRepositoryLive } from '../workspace/index.js';
import { collectTmuxGarbage } from './adapters/tmux-gc.js';
import {
  PtyBackend,
  PtyRepository,
  PtyRepositoryLive,
  PtyService,
  PtyServiceError,
  PtyServiceLive,
  PtyKillError,
  PtyStartError,
  type LaunchBackendSessionInput,
  type PtyBackendShape,
  type PtyRepositoryService,
} from './index.js';
import { detectOrphanPtyLogs } from './service/logs.js';

test('launch creates metadata, writes output to the log, and marks running attention', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-launch-'));
  const fake = fakeBackend();
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const pty = yield* PtyService;
        const launched = yield* pty.launch({ worktreeId, purpose: 'terminal', harness: null });
        const surfaces = yield* SurfaceService;
        return { launched, detail: yield* surfaces.getSurfaceDetail(launched.surfaceId) };
      }).pipe(Effect.provide(testLayer(dataRoot, fake.backend))),
    );

    assert.equal(output.launched.worktreeId, output.detail.worktreeId);
    assert.equal(output.detail.attention, 'working');
    assert.equal(output.detail.panes[0]?.attention, 'working');
    assert.equal(output.detail.panes[0]?.ptySession?.status, 'running');
    assert.equal(output.detail.panes[0]?.ptySession?.command, process.env.SHELL || 'bash');
    assert.ok(
      readFileSync(
        join(dataRoot, 'sessions', `${output.launched.ptySessionId}.ptylog`),
        'utf8',
      ).startsWith('hello from pty'),
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('orphan log detection reports unreferenced pty logs without deleting them', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-orphan-logs-'));
  mkdirSync(join(dataRoot, 'sessions'), { recursive: true });
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const repository = yield* PtyRepository;
        const metadata = yield* repository.createLaunchMetadata({
          worktreeId,
          kind: 'terminal',
          titleBase: 'Terminal',
          purpose: 'terminal',
          harness: null,
          command: process.env.SHELL || 'bash',
        });
        const logPath = join(dataRoot, 'sessions', `${metadata.ptySessionId}.ptylog`);
        yield* repository.updateBackendMetadata({
          ptySessionId: metadata.ptySessionId,
          backend: 'node_pty',
          backendRefJson: JSON.stringify({
            schemaVersion: 1,
            backend: 'node_pty',
            ptySessionId: metadata.ptySessionId,
            pid: null,
          }),
          logMode: 'backend_file',
          logPath,
        });
        writeFileSync(logPath, 'referenced', 'utf8');
        const orphanPath = join(dataRoot, 'sessions', 'orphan.ptylog');
        writeFileSync(orphanPath, 'orphan', 'utf8');

        return {
          orphans: yield* detectOrphanPtyLogs(repository, join(dataRoot, 'sessions')),
          orphanPath,
        };
      }).pipe(Effect.provide(repositoryOnlyLayer(dataRoot))),
    );

    assert.deepEqual(output.orphans, ['sessions/orphan.ptylog']);
    assert.equal(readFileSync(output.orphanPath, 'utf8'), 'orphan');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('new sessions do not reuse deleted pty ids or orphaned log paths', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-id-reuse-'));
  const fake = fakeBackend();
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const firstWorktree = yield* insertProjectWorktree('/repo/isagi-one');
        const pty = yield* PtyService;
        const first = yield* pty.launch({
          worktreeId: firstWorktree.worktreeId,
          purpose: 'terminal',
          harness: null,
        });
        const workspaceRepository = yield* WorkspaceRepository;
        yield* workspaceRepository.deleteProject(firstWorktree.projectId);

        const secondWorktree = yield* insertProjectWorktree('/repo/isagi-two');
        const second = yield* pty.launch({
          worktreeId: secondWorktree.worktreeId,
          purpose: 'terminal',
          harness: null,
        });
        return { first, second };
      }).pipe(Effect.provide(testLayer(dataRoot, fake.backend))),
    );

    const firstLogPath = join(dataRoot, 'sessions', `${output.first.ptySessionId}.ptylog`);
    const secondLogPath = join(dataRoot, 'sessions', `${output.second.ptySessionId}.ptylog`);
    assert.ok(output.second.ptySessionId > output.first.ptySessionId);
    assert.notEqual(firstLogPath, secondLogPath);
    assert.equal(readFileSync(firstLogPath, 'utf8'), 'hello from pty');
    assert.equal(readFileSync(secondLogPath, 'utf8'), 'hello from pty');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('spawn failure returns created ids and persists a failed visible session with log text', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-failed-spawn-'));
  const fake = fakeBackend({ failStart: true });
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const pty = yield* PtyService;
        const launched = yield* pty.launch({ worktreeId, purpose: 'agent', harness: 'pi' });
        const surfaces = yield* SurfaceService;
        return { launched, detail: yield* surfaces.getSurfaceDetail(launched.surfaceId) };
      }).pipe(Effect.provide(testLayer(dataRoot, fake.backend))),
    );

    assert.equal(output.detail.title, 'Pi');
    assert.equal(output.detail.attention, 'error');
    assert.equal(output.detail.panes[0]?.ptySession?.status, 'failed');
    assert.equal(output.detail.panes[0]?.ptySession?.statusReason, 'backend_launch_failed');
    assert.equal(output.detail.panes[0]?.ptySession?.command, 'pi');
    const log = readFileSync(
      join(dataRoot, 'sessions', `${output.launched.ptySessionId}.ptylog`),
      'utf8',
    );
    assert.match(log, /Failed to start pi/);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('exit updates status and attention honestly', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-exit-'));
  const fake = fakeBackend();
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const pty = yield* PtyService;
        const launched = yield* pty.launch({ worktreeId, purpose: 'terminal', harness: null });
        fake.exits.get(launched.ptySessionId)?.({ exitCode: 1, signal: null });
        yield* waitUntilDetail(
          launched.surfaceId,
          (detail) => detail.panes[0]?.ptySession?.status === 'failed',
        );
        const surfaces = yield* SurfaceService;
        return { launched, detail: yield* surfaces.getSurfaceDetail(launched.surfaceId) };
      }).pipe(Effect.provide(testLayer(dataRoot, fake.backend))),
    );

    assert.equal(output.detail.attention, 'error');
    assert.equal(output.detail.panes[0]?.ptySession?.exitCode, 1);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('PTY lifecycle publishes session change events for launch and process exit', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-events-exit-'));
  const fake = fakeBackend();
  const events: RuntimeEvent[] = [];
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const pty = yield* PtyService;
        const launched = yield* pty.launch({ worktreeId, purpose: 'terminal', harness: null });
        fake.exits.get(launched.ptySessionId)?.({ exitCode: 1, signal: null });
        yield* waitUntil(() => events.length >= 2);
        return { launched, launchEvent: events[0]!, exitEvent: events[1]! };
      }).pipe(Effect.provide(testLayer(dataRoot, fake.backend, { events }))),
    );

    assert.deepEqual(output.launchEvent, {
      id: output.launchEvent.id,
      type: 'pty_session_changed',
      occurredAt: output.launchEvent.occurredAt,
      payload: {
        ptySessionId: output.launched.ptySessionId,
        worktreeId: output.launched.worktreeId,
        surfaceId: output.launched.surfaceId,
        paneId: output.launched.paneId,
        previousStatus: 'starting',
        status: 'running',
        previousStatusReason: null,
        statusReason: null,
      },
    } satisfies RuntimeEvent);
    assert.deepEqual(output.exitEvent, {
      id: output.exitEvent.id,
      type: 'pty_session_changed',
      occurredAt: output.exitEvent.occurredAt,
      payload: {
        ptySessionId: output.launched.ptySessionId,
        worktreeId: output.launched.worktreeId,
        surfaceId: output.launched.surfaceId,
        paneId: output.launched.paneId,
        previousStatus: 'running',
        status: 'failed',
        previousStatusReason: null,
        statusReason: null,
      },
    } satisfies RuntimeEvent);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('attach captures replay offset before live output so replay and live stream do not gap', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-attach-'));
  const fake = fakeBackend();
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const pty = yield* PtyService;
        const launched = yield* pty.launch({ worktreeId, purpose: 'terminal', harness: null });
        const messages: unknown[] = [];
        const attachment = yield* pty.attach({
          ptySessionId: launched.ptySessionId,
          send: (message) => messages.push(message),
        });
        fake.outputs.get(launched.ptySessionId)?.('during replay');
        const replayed: unknown[] = [];
        yield* pty.replay({
          session: attachment.session,
          bytes: attachment.replayBytes,
          send: (message) => replayed.push(message),
        });
        attachment.unsubscribe();
        return { launched, messages, replayed };
      }).pipe(Effect.provide(testLayer(dataRoot, fake.backend))),
    );

    assert.deepEqual(output.replayed, [
      { type: 'replay_start', bytes: Buffer.byteLength('hello from pty') },
      { type: 'output', data: 'hello from pty', replay: true },
      { type: 'replay_end' },
    ]);
    assert.deepEqual(output.messages, [{ type: 'output', data: 'during replay' }]);
    assert.ok(
      readFileSync(
        join(dataRoot, 'sessions', `${output.launched.ptySessionId}.ptylog`),
        'utf8',
      ).startsWith('hello from ptyduring replay'),
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('historical file-backed replay does not depend on the active backend', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-replay-historical-backend-'));
  try {
    const replayed = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const pty = yield* PtyService;
        const repository = yield* PtyRepository;
        const metadata = yield* repository.createLaunchMetadata({
          worktreeId,
          kind: 'terminal',
          titleBase: 'Terminal',
          purpose: 'terminal',
          harness: null,
          command: process.env.SHELL || 'bash',
        });
        const logPath = join(dataRoot, 'sessions', `${metadata.ptySessionId}.ptylog`);
        writeFileSync(logPath, 'old node pty output', 'utf8');
        yield* repository.updateBackendMetadata({
          ptySessionId: metadata.ptySessionId,
          backend: 'node_pty',
          backendRefJson: JSON.stringify({
            schemaVersion: 1,
            backend: 'node_pty',
            ptySessionId: metadata.ptySessionId,
            pid: null,
          }),
          logMode: 'backend_file',
          logPath,
        });
        yield* repository.transitionSession({
          ptySessionId: metadata.ptySessionId,
          status: 'failed',
          statusReason: 'runtime_ephemeral_lost',
          exitCode: null,
          signal: null,
        });
        const session = yield* repository.findSession(metadata.ptySessionId);
        if (!session) {
          return yield* Effect.die('Expected test PTY session to exist.');
        }
        const messages: unknown[] = [];
        yield* pty.replay({
          session,
          bytes: null,
          send: (message) => messages.push(message),
        });
        return messages;
      }).pipe(Effect.provide(testLayer(dataRoot, fakeTmuxBackend('alive')))),
    );

    assert.deepEqual(replayed, [
      { type: 'replay_start', bytes: Buffer.byteLength('old node pty output') },
      { type: 'output', data: 'old node pty output', replay: true },
      { type: 'replay_end' },
    ]);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('replaced websocket attachment cannot keep writing to the current session', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-replaced-attach-'));
  const fake = fakeBackend();
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const pty = yield* PtyService;
        const launched = yield* pty.launch({ worktreeId, purpose: 'terminal', harness: null });
        const first = yield* pty.attach({
          ptySessionId: launched.ptySessionId,
          send: () => {},
        });
        const second = yield* pty.attach({
          ptySessionId: launched.ptySessionId,
          send: () => {},
        });
        const staleWrite = yield* pty
          .write({
            ptySessionId: launched.ptySessionId,
            attachmentId: first.attachmentId,
            data: 'stale',
          })
          .pipe(Effect.either);
        const currentWrite = yield* pty.write({
          ptySessionId: launched.ptySessionId,
          attachmentId: second.attachmentId,
          data: 'current',
        });
        second.unsubscribe();
        return { staleWrite, currentWrite };
      }).pipe(Effect.provide(testLayer(dataRoot, fake.backend))),
    );

    assert.ok(Either.isLeft(output.staleWrite));
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('missing runtime-local backend session returns attach code and durable reason', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-missing-backend-'));
  const fake = fakeBackend({ failAttach: true });
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const pty = yield* PtyService;
        const launched = yield* pty.launch({ worktreeId, purpose: 'terminal', harness: null });
        const attachResult = yield* pty
          .attach({
            ptySessionId: launched.ptySessionId,
            send: () => {},
          })
          .pipe(Effect.either);
        const surfaces = yield* SurfaceService;
        return {
          attachResult,
          detail: yield* surfaces.getSurfaceDetail(launched.surfaceId),
        };
      }).pipe(Effect.provide(testLayer(dataRoot, fake.backend))),
    );

    assert.ok(Either.isLeft(output.attachResult));
    assert.ok(output.attachResult.left instanceof PtyServiceError);
    assert.equal(output.attachResult.left.code, 'backend_attach_failed');
    assert.equal(output.detail.panes[0]?.ptySession?.status, 'failed');
    assert.equal(output.detail.panes[0]?.ptySession?.statusReason, 'runtime_ephemeral_lost');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('graceful service shutdown marks live node-pty sessions failed without recovery reason', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-graceful-shutdown-'));
  try {
    const launched = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const pty = yield* PtyService;
        return yield* pty.launch({ worktreeId, purpose: 'terminal', harness: null });
      }).pipe(Effect.provide(testLayer(dataRoot, fakeBackend().backend))),
    );

    const detail = await Effect.runPromise(
      Effect.gen(function* () {
        const surfaces = yield* SurfaceService;
        return yield* surfaces.getSurfaceDetail(launched.surfaceId);
      }).pipe(Effect.provide(testLayer(dataRoot, fakeBackend().backend))),
    );

    assert.equal(detail.panes[0]?.ptySession?.status, 'failed');
    assert.equal(detail.panes[0]?.ptySession?.statusReason, null);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('startup recovery marks persisted live node-pty sessions failed without mutating logs', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-restart-'));
  try {
    const launched = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const repository = yield* PtyRepository;
        const metadata = yield* repository.createLaunchMetadata({
          worktreeId,
          kind: 'terminal',
          titleBase: 'Terminal',
          purpose: 'terminal',
          harness: null,
          command: process.env.SHELL || 'bash',
        });
        return {
          worktreeId: metadata.worktreeId,
          surfaceId: metadata.surfaceId,
          paneId: metadata.paneId,
          ptySessionId: metadata.ptySessionId,
        };
      }).pipe(Effect.provide(repositoryOnlyLayer(dataRoot))),
    );

    const recovered = await Effect.runPromise(
      Effect.gen(function* () {
        const surfaces = yield* SurfaceService;
        return yield* surfaces.getSurfaceDetail(launched.surfaceId);
      }).pipe(Effect.provide(testLayer(dataRoot, fakeBackend().backend))),
    );

    assert.equal(recovered.panes[0]?.ptySession?.status, 'failed');
    assert.equal(recovered.panes[0]?.ptySession?.statusReason, 'runtime_ephemeral_lost');
    const logPath = join(dataRoot, 'sessions', `${launched.ptySessionId}.ptylog`);
    assert.equal(existsSync(logPath), false);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('startup reconciliation treats missing tmux sessions as backend missing even when normal exit is indistinguishable', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-tmux-missing-'));
  try {
    const launched = await Effect.runPromise(
      createPersistedTmuxSession('/repo/isagi', dataRoot, { statusReason: null }).pipe(
        Effect.provide(repositoryOnlyLayer(dataRoot)),
      ),
    );

    const recovered = await Effect.runPromise(
      Effect.gen(function* () {
        const surfaces = yield* SurfaceService;
        return yield* surfaces.getSurfaceDetail(launched.surfaceId);
      }).pipe(Effect.provide(testLayer(dataRoot, fakeTmuxBackend('missing')))),
    );

    assert.equal(recovered.panes[0]?.ptySession?.status, 'failed');
    assert.equal(recovered.panes[0]?.ptySession?.statusReason, 'backend_session_missing');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('startup reconciliation publishes missing tmux session events through the real PTY service', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-events-tmux-missing-'));
  const events: RuntimeEvent[] = [];
  try {
    const launched = await Effect.runPromise(
      createPersistedTmuxSession('/repo/isagi', dataRoot, { statusReason: null }).pipe(
        Effect.provide(repositoryOnlyLayer(dataRoot)),
      ),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* PtyService;
      }).pipe(Effect.provide(testLayer(dataRoot, fakeTmuxBackend('missing'), { events }))),
    );
    const event = events[0];

    assert.ok(event);

    assert.deepEqual(event, {
      id: event.id,
      type: 'pty_session_changed',
      occurredAt: event.occurredAt,
      payload: {
        ptySessionId: launched.ptySessionId,
        worktreeId: launched.worktreeId,
        surfaceId: launched.surfaceId,
        paneId: launched.paneId,
        previousStatus: 'running',
        status: 'failed',
        previousStatusReason: null,
        statusReason: 'backend_session_missing',
      },
    } satisfies RuntimeEvent);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('startup reconciliation does not publish when only lastSeenAt changes', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-events-no-change-'));
  const events: RuntimeEvent[] = [];
  try {
    await Effect.runPromise(
      createPersistedTmuxSession('/repo/isagi', dataRoot, { statusReason: null }).pipe(
        Effect.provide(repositoryOnlyLayer(dataRoot)),
      ),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* PtyService;
        yield* Effect.sleep('50 millis');
      }).pipe(Effect.provide(testLayer(dataRoot, fakeTmuxBackend('alive'), { events }))),
    );

    assert.deepEqual(events, []);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('startup reconciliation keeps tmux sessions recoverable when backend is unavailable', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-tmux-unavailable-'));
  try {
    const launched = await Effect.runPromise(
      createPersistedTmuxSession('/repo/isagi', dataRoot, { statusReason: null }).pipe(
        Effect.provide(repositoryOnlyLayer(dataRoot)),
      ),
    );

    const recovered = await Effect.runPromise(
      Effect.gen(function* () {
        const surfaces = yield* SurfaceService;
        return yield* surfaces.getSurfaceDetail(launched.surfaceId);
      }).pipe(Effect.provide(testLayer(dataRoot, fakeTmuxBackend('unavailable')))),
    );

    assert.equal(recovered.panes[0]?.ptySession?.status, 'running');
    assert.equal(recovered.panes[0]?.ptySession?.statusReason, 'backend_unavailable');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('kill service terminates tmux session and marks it killed', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-kill-tmux-'));
  const killedSessionNames: string[] = [];
  const backend = fakeTmuxBackend('alive', { killedSessionNames });
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const pty = yield* PtyService;
        const launched = yield* pty.launch({ worktreeId, purpose: 'terminal', harness: null });
        yield* pty.kill({ ptySessionId: launched.ptySessionId });
        const surfaces = yield* SurfaceService;
        return { launched, detail: yield* surfaces.getSurfaceDetail(launched.surfaceId) };
      }).pipe(Effect.provide(testLayer(dataRoot, backend))),
    );

    assert.deepEqual(killedSessionNames, [
      `isagi_${dataDirectoryHashForTest(dataRoot)}_${output.launched.ptySessionId}`,
    ]);
    assert.equal(output.detail.panes[0]?.ptySession?.status, 'killed');
    assert.equal(output.detail.panes[0]?.ptySession?.statusReason, null);
    assert.equal(output.detail.panes[0]?.ptySession?.exitCode, null);
    assert.equal(output.detail.panes[0]?.ptySession?.signal, null);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('kill service terminates node-pty session and marks it killed', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-kill-node-'));
  const fake = fakeBackend();
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const pty = yield* PtyService;
        const launched = yield* pty.launch({ worktreeId, purpose: 'terminal', harness: null });
        yield* pty.kill({ ptySessionId: launched.ptySessionId });
        const surfaces = yield* SurfaceService;
        return { launched, detail: yield* surfaces.getSurfaceDetail(launched.surfaceId) };
      }).pipe(Effect.provide(testLayer(dataRoot, fake.backend))),
    );

    assert.equal(fake.kills.has(output.launched.ptySessionId), true);
    assert.equal(output.detail.panes[0]?.ptySession?.status, 'killed');
    assert.equal(output.detail.panes[0]?.ptySession?.statusReason, null);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('kill service keeps killed status when node-pty exit fires during kill', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-kill-node-exit-'));
  const fake = fakeBackend({ exitOnKill: { exitCode: null, signal: 'SIGTERM' } });
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const pty = yield* PtyService;
        const launched = yield* pty.launch({ worktreeId, purpose: 'terminal', harness: null });
        yield* pty.kill({ ptySessionId: launched.ptySessionId });
        yield* Effect.sleep('20 millis');
        const surfaces = yield* SurfaceService;
        return { launched, detail: yield* surfaces.getSurfaceDetail(launched.surfaceId) };
      }).pipe(Effect.provide(testLayer(dataRoot, fake.backend))),
    );

    assert.equal(fake.kills.has(output.launched.ptySessionId), true);
    assert.equal(output.detail.panes[0]?.ptySession?.status, 'killed');
    assert.equal(output.detail.panes[0]?.ptySession?.statusReason, null);
    assert.equal(output.detail.panes[0]?.ptySession?.exitCode, null);
    assert.equal(output.detail.panes[0]?.ptySession?.signal, null);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('failed kill service persists captured node-pty exit normally', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-kill-node-fails-'));
  const fake = fakeBackend({
    failKill: true,
    exitOnKill: { exitCode: 7, signal: null },
  });
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const pty = yield* PtyService;
        const launched = yield* pty.launch({ worktreeId, purpose: 'terminal', harness: null });
        const killResult = yield* pty
          .kill({ ptySessionId: launched.ptySessionId })
          .pipe(Effect.either);
        const surfaces = yield* SurfaceService;
        return {
          launched,
          killResult,
          detail: yield* surfaces.getSurfaceDetail(launched.surfaceId),
        };
      }).pipe(Effect.provide(testLayer(dataRoot, fake.backend))),
    );

    assert.ok(Either.isLeft(output.killResult));
    assert.ok(output.killResult.left instanceof PtyKillError);
    assert.equal(fake.kills.has(output.launched.ptySessionId), true);
    assert.equal(output.detail.panes[0]?.ptySession?.status, 'failed');
    assert.equal(output.detail.panes[0]?.ptySession?.statusReason, null);
    assert.equal(output.detail.panes[0]?.ptySession?.exitCode, 7);
    assert.equal(output.detail.panes[0]?.ptySession?.signal, null);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('kill retry keeps killed status when node-pty exit arrives after retry', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-kill-retry-exit-'));
  const fake = fakeBackend({
    exitOnKill: { exitCode: 9, signal: null },
    exitOnKillDelayMs: 1_200,
  });
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const pty = yield* PtyService;
        const launched = yield* pty.launch({
          worktreeId: 1,
          purpose: 'terminal',
          harness: null,
        });
        const killResult = yield* pty
          .kill({ ptySessionId: launched.ptySessionId })
          .pipe(Effect.either);
        yield* Effect.sleep('1400 millis');
        return { killResult, session: retrySession };
      }).pipe(Effect.provide(killRetryLayer(dataRoot, fake.backend))),
    );

    assert.ok(Either.isLeft(output.killResult));
    assert.ok(output.killResult.left instanceof DatabaseError);
    assert.equal(output.session?.status, 'killed');
    assert.equal(output.session?.statusReason, null);
    assert.equal(output.session?.exitCode, null);
    assert.equal(output.session?.signal, null);
  } finally {
    retrySession = null;
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

let retrySession: PtySessionRow | null = null;

function fakeBackend(
  options: {
    readonly failStart?: boolean;
    readonly failAttach?: boolean;
    readonly failKill?: boolean;
    readonly exitOnKill?:
      | {
          readonly exitCode: number | null;
          readonly signal: string | null;
        }
      | undefined;
    readonly exitOnKillDelayMs?: number | undefined;
  } = {},
) {
  let nextPid = 100;
  const outputs = new Map<number, (data: string) => void>();
  const exits = new Map<
    number,
    (exit: { readonly exitCode: number | null; readonly signal: string | null }) => void
  >();
  const logPaths = new Map<number, string | null>();
  const kills = new Set<number>();
  const backend = {
    name: 'node_pty',
    available: Effect.succeed(true),
    launch: (input: LaunchBackendSessionInput) =>
      Effect.try({
        try: () => {
          if (options.failStart) {
            throw new Error('spawn failed');
          }
          const pid = nextPid++;
          appendFakeLog(input.logPath, 'hello from pty');
          logPaths.set(input.ptySessionId, input.logPath);
          exits.set(input.ptySessionId, input.onExit);
          return {
            schemaVersion: 1,
            backend: 'node_pty',
            ptySessionId: input.ptySessionId,
            pid,
          } as const;
        },
        catch: (cause) =>
          new PtyStartError({
            ptySessionId: input.ptySessionId,
            command: input.command,
            cwd: input.cwd,
            cause,
          }),
      }),
    attach: (input) =>
      Effect.try({
        try: () => {
          if (options.failAttach) {
            throw new Error('attach failed');
          }
          if (input.ref.backend !== 'node_pty') {
            throw new Error(`Unexpected fake backend ref ${input.ref.backend}.`);
          }
          const ref = input.ref;
          outputs.set(ref.ptySessionId, (data) => {
            appendFakeLog(logPaths.get(ref.ptySessionId) ?? null, data);
            input.onOutput(data);
          });
          const existingExit = exits.get(ref.ptySessionId);
          exits.set(ref.ptySessionId, (exit) => {
            input.onSessionExit(exit);
            existingExit?.(exit);
          });
          return {
            write: () => Effect.void,
            resize: () => Effect.void,
            detach: Effect.sync(() => {
              outputs.delete(ref.ptySessionId);
            }),
          };
        },
        catch: (cause) =>
          new PtyStartError({
            ptySessionId: input.ref.backend === 'node_pty' ? input.ref.ptySessionId : undefined,
            command: 'node_pty_attach',
            cwd: '',
            cause,
          }),
      }),
    replay: (input) => replayFakeLog(input.logPath, input.bytes, input.send),
    inspect: () => Effect.succeed({ status: 'alive' as const }),
    listSessions: Effect.sync(() =>
      [...logPaths.keys()].map(
        (ptySessionId) =>
          ({
            schemaVersion: 1,
            backend: 'node_pty',
            ptySessionId,
            pid: null,
          }) as const,
      ),
    ),
    kill: (ref) =>
      Effect.gen(function* () {
        if (ref.backend === 'node_pty') {
          kills.add(ref.ptySessionId);
          if (options.exitOnKill) {
            if (options.exitOnKillDelayMs !== undefined) {
              setTimeout(
                () => exits.get(ref.ptySessionId)?.(options.exitOnKill!),
                options.exitOnKillDelayMs,
              );
            } else {
              exits.get(ref.ptySessionId)?.(options.exitOnKill);
              yield* Effect.sleep('10 millis');
            }
          }
          if (options.failKill) {
            return yield* Effect.fail(
              new PtyKillError({
                ptySessionId: ref.ptySessionId,
                cause: new Error('kill failed'),
              }),
            );
          }
        }
      }),
  } satisfies PtyBackendShape;
  return { backend, outputs, exits, kills };
}

function fakeTmuxBackend(
  inspection: 'alive' | 'missing' | 'unavailable',
  options: {
    readonly sessionNames?: readonly string[];
    readonly killedSessionNames?: string[];
  } = {},
) {
  const listSessions = Effect.succeed(
    (options.sessionNames ?? []).map(
      (sessionName) =>
        ({
          schemaVersion: 1,
          backend: 'tmux',
          sessionName,
        }) as const,
    ),
  );
  return {
    name: 'tmux',
    available: Effect.succeed(true),
    launch: (input: LaunchBackendSessionInput) =>
      Effect.succeed({
        schemaVersion: 1,
        backend: 'tmux',
        sessionName: input.backendSessionName ?? `isagi_test_${input.ptySessionId}`,
      } as const),
    attach: () =>
      Effect.succeed({
        write: () => Effect.void,
        resize: () => Effect.void,
        detach: Effect.void,
      }),
    replay: (input) =>
      Effect.sync(() => {
        input.send({ type: 'replay_start', bytes: 0 });
        input.send({ type: 'replay_end' });
      }),
    inspect: () =>
      Effect.succeed(
        inspection === 'unavailable'
          ? { status: 'unavailable' as const }
          : { status: inspection as 'alive' | 'missing' },
      ),
    listSessions,
    collectGarbage: (input) => collectTmuxGarbage(input, listSessions),
    kill: (ref) =>
      Effect.sync(() => {
        if (ref.backend === 'tmux') {
          options.killedSessionNames?.push(ref.sessionName);
        }
      }),
  } satisfies PtyBackendShape;
}

function createPersistedTmuxSession(
  rootPath: string,
  dataRoot: string,
  input: {
    readonly status?: import('@isagi/contracts').PtySessionStatus | undefined;
    readonly statusReason: import('@isagi/contracts').PtySessionStatusReason | null;
  },
) {
  return Effect.gen(function* () {
    const worktreeId = yield* insertWorktree(rootPath);
    const repository = yield* PtyRepository;
    const metadata = yield* repository.createLaunchMetadata({
      worktreeId,
      kind: 'terminal',
      titleBase: 'Terminal',
      purpose: 'terminal',
      harness: null,
      command: process.env.SHELL || 'bash',
    });
    const sessionName = `isagi_test_${metadata.ptySessionId}`;
    yield* repository.updateBackendMetadata({
      ptySessionId: metadata.ptySessionId,
      backend: 'tmux',
      backendRefJson: JSON.stringify({
        schemaVersion: 1,
        backend: 'tmux',
        sessionName,
      }),
      logMode: 'none',
      logPath: null,
    });
    yield* repository.transitionSession({
      ptySessionId: metadata.ptySessionId,
      status: input.status ?? 'running',
      statusReason: input.statusReason,
      exitCode: null,
      signal: null,
    });
    return {
      worktreeId: metadata.worktreeId,
      surfaceId: metadata.surfaceId,
      paneId: metadata.paneId,
      ptySessionId: metadata.ptySessionId,
      dataRoot,
    };
  });
}

function appendFakeLog(path: string | null, data: string) {
  if (path) {
    appendFileSync(path, data, 'utf8');
  }
}

function replayFakeLog(
  path: string | null,
  limitBytes: number | null,
  send: (message: import('@isagi/contracts').PtyWebSocketOutputMessage) => void,
) {
  return Effect.sync(() => {
    const bytes = path && existsSync(path) ? (limitBytes ?? statSync(path).size) : 0;
    send({ type: 'replay_start', bytes });
    if (path && bytes > 0) {
      const fd = openSync(path, 'r');
      try {
        const buffer = Buffer.allocUnsafe(bytes);
        const read = readSync(fd, buffer, 0, bytes, 0);
        if (read > 0) {
          send({ type: 'output', data: buffer.toString('utf8', 0, read), replay: true });
        }
      } finally {
        closeSync(fd);
      }
    }
    send({ type: 'replay_end' });
  });
}

function insertWorktree(rootPath: string) {
  return insertProjectWorktree(rootPath).pipe(Effect.map((row) => row.worktreeId));
}

function insertProjectWorktree(rootPath: string) {
  return Effect.gen(function* () {
    const workspaceRepository = yield* WorkspaceRepository;
    const projectId = yield* workspaceRepository.insertProject({ name: 'isagi', rootPath });
    yield* workspaceRepository.reconcileProjectWorktrees({
      projectId,
      discovered: [{ path: rootPath, branch: 'main', head: 'abcdef0' }],
    });
    const worktrees = yield* workspaceRepository.listWorktrees;
    const worktree = worktrees.find((candidate) => candidate.projectId === projectId);
    if (!worktree) {
      return yield* Effect.die('Expected test worktree to be inserted.');
    }
    return { projectId, worktreeId: worktree.id };
  });
}

function waitUntilDetail(surfaceId: number, predicate: (detail: SurfaceDetail) => boolean) {
  return Effect.gen(function* () {
    const surfaces = yield* SurfaceService;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const detail = yield* surfaces.getSurfaceDetail(surfaceId);
      if (predicate(detail)) {
        return detail;
      }
      yield* Effect.sleep('10 millis');
    }
    return yield* Effect.die('Timed out waiting for surface detail predicate.');
  });
}

function repositoryOnlyLayer(dataRoot: string) {
  const dataDirectory = dataDirectoryService(dataRoot);
  const dataDirectoryLayer = Layer.succeed(DataDirectory, dataDirectory);
  const database = RuntimeDatabaseLive.pipe(Layer.provide(dataDirectoryLayer));
  const workspaceRepository = WorkspaceRepositoryLive.pipe(Layer.provide(database));
  const surfaceRepository = SurfaceRepositoryLive.pipe(
    Layer.provide(database),
    Layer.provide(dataDirectoryLayer),
  );
  const ptyRepository = PtyRepositoryLive.pipe(
    Layer.provide(database),
    Layer.provide(surfaceRepository),
  );
  return Layer.mergeAll(workspaceRepository, surfaceRepository, ptyRepository);
}

function testLayer(
  dataRoot: string,
  backend: PtyBackendShape,
  options: { readonly events?: RuntimeEvent[] | undefined } = {},
) {
  const dataDirectory = dataDirectoryService(dataRoot);

  const dataDirectoryLayer = Layer.succeed(DataDirectory, dataDirectory);
  const database = RuntimeDatabaseLive.pipe(Layer.provide(dataDirectoryLayer));
  const workspaceRepository = WorkspaceRepositoryLive.pipe(Layer.provide(database));
  const surfaceRepository = SurfaceRepositoryLive.pipe(
    Layer.provide(database),
    Layer.provide(dataDirectoryLayer),
  );
  const surfaceService = SurfaceServiceLive.pipe(Layer.provide(surfaceRepository));
  const ptyRepository = PtyRepositoryLive.pipe(
    Layer.provide(database),
    Layer.provide(surfaceRepository),
  );
  const ptyService = PtyServiceLive.pipe(
    Layer.provide(ptyRepository),
    Layer.provide(Layer.succeed(PtyBackend, backend)),
    Layer.provide(dataDirectoryLayer),
  );
  const ptyServiceWithEvents = Layer.provideMerge(ptyService, runtimeEventBusLayer(options.events));
  return Layer.mergeAll(
    workspaceRepository,
    surfaceRepository,
    surfaceService,
    ptyRepository,
    ptyServiceWithEvents,
  );
}

function killRetryLayer(dataRoot: string, backend: PtyBackendShape) {
  const dataDirectory = dataDirectoryService(dataRoot);
  const dataDirectoryLayer = Layer.succeed(DataDirectory, dataDirectory);
  const ptyRepository = Layer.succeed(PtyRepository, retryRepository());
  const ptyService = PtyServiceLive.pipe(
    Layer.provide(ptyRepository),
    Layer.provide(Layer.succeed(PtyBackend, backend)),
    Layer.provide(dataDirectoryLayer),
  );
  return Layer.provideMerge(ptyService, RuntimeEventBusLive);
}

function runtimeEventBusLayer(events: RuntimeEvent[] | undefined) {
  if (!events) {
    return RuntimeEventBusLive;
  }
  return Layer.succeed(RuntimeEventBus, {
    publish: (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    subscribe: Effect.die('Event sink test bus does not support subscriptions.'),
  } satisfies RuntimeEventBusService);
}

function waitUntil(predicate: () => boolean) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (predicate()) {
        return;
      }
      yield* Effect.sleep('10 millis');
    }
    return yield* Effect.die('Timed out waiting for predicate.');
  });
}

function retryRepository() {
  let killedTransitionFailed = false;
  return {
    createLaunchMetadata: () =>
      Effect.sync(() => {
        retrySession = {
          id: 1,
          paneId: 1,
          surfaceId: 1,
          worktreeId: 1,
          backend: 'node_pty',
          backendRefJson: JSON.stringify({
            schemaVersion: 1,
            backend: 'node_pty',
            ptySessionId: 1,
            pid: null,
          }),
          purpose: 'terminal',
          harness: null,
          command: process.env.SHELL || 'bash',
          cwd: '/repo/isagi',
          status: 'starting',
          statusReason: null,
          exitCode: null,
          signal: null,
          logMode: 'none',
          logPath: null,
          createdAt: '2026-06-12T00:00:00.000Z',
          updatedAt: '2026-06-12T00:00:00.000Z',
          exitedAt: null,
          lastSeenAt: null,
        };
        return {
          worktreeId: 1,
          surfaceId: 1,
          paneId: 1,
          ptySessionId: 1,
          command: retrySession.command,
          cwd: retrySession.cwd,
          logPath: retrySession.logPath,
        };
      }),
    findSession: () => Effect.succeed(retrySession),
    listSessionLogPaths: Effect.succeed([]),
    listSessions: () => Effect.succeed([]),
    updateBackendRef: (input) =>
      Effect.sync(() => {
        if (retrySession) {
          retrySession = { ...retrySession, backendRefJson: input.backendRefJson };
        }
      }),
    updateBackendMetadata: (input) =>
      Effect.sync(() => {
        if (retrySession) {
          retrySession = {
            ...retrySession,
            backend: input.backend,
            backendRefJson: input.backendRefJson,
            logMode: input.logMode,
            logPath: input.logPath,
          };
        }
      }),
    transitionSession: (input) =>
      Effect.gen(function* () {
        if (input.status === 'killed' && !killedTransitionFailed) {
          killedTransitionFailed = true;
          return yield* Effect.fail(
            new DatabaseError({
              operation: 'transition_pty_session',
              cause: new Error('transient transition failure'),
            }),
          );
        }
        if (retrySession) {
          retrySession = {
            ...retrySession,
            status: input.status,
            statusReason: input.statusReason ?? null,
            exitCode: input.exitCode ?? null,
            signal: input.signal ?? null,
          };
        }
      }),
  } satisfies PtyRepositoryService;
}

function dataDirectoryHashForTest(path: string) {
  return createHash('sha256').update(resolve(path)).digest('hex').slice(0, 8);
}

function dataDirectoryService(dataRoot: string) {
  return {
    paths: {
      root: dataRoot,
      databasePath: join(dataRoot, 'isagi.db'),
      statePath: join(dataRoot, 'state.json'),
      worktreesPath: join(dataRoot, 'worktrees'),
      sessionsPath: join(dataRoot, 'sessions'),
    },
  } satisfies DataDirectoryService;
}
