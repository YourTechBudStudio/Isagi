import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Either, Layer } from 'effect';

import { UserShell, type UserShellService } from '../host-inventory/user-shell.service.js';
import { DataDirectory, RuntimeDatabaseLive } from '../persistence/index.js';
import { makeTestDataDirectory } from '../persistence/test-support.js';
import { InternalRuntimeEventBusLive } from '../runtime-events/index.js';
import { PtyBackendCatalog } from './backend.js';
import { PtyForegroundStateLive } from './foreground-state.js';
import { PtyRepository, PtyRepositoryLive, type PtyRepositoryService } from './pty.repository.js';
import { PtyService, PtyServiceLive } from './pty.service.js';
import { fakeBackendCatalog } from './test-support.js';
import {
  PtyServiceError,
  type PtyBackend as PtyBackendShape,
  type PtyBackendName,
} from './types.js';

// The production cross-backend case: a tmux incarnation persisted by an earlier,
// tmux-configured runtime, now operated by a node-pty-configured one. Before the
// backend catalog every one of these operations failed `backend_unavailable`
// purely because the row's backend differed from the launch preference.

function testUserShell(): UserShellService {
  return {
    environment: {
      _tag: 'Available' as const,
      values: { HOME: '/home/developer', PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' },
    },
    run: () => Effect.die('cross-backend tests do not run user-shell commands.'),
  };
}

function backendStub(name: PtyBackendName, overrides: Partial<PtyBackendShape> = {}) {
  return {
    name,
    available: Effect.succeed(true),
    launch: () => Effect.die(`${name} launch is not expected here`),
    writeInput: () => Effect.void,
    attach: () =>
      Effect.succeed({
        replayBytes: 0,
        write: () => Effect.void,
        resize: () => Effect.void,
        detach: Effect.void,
      }),
    replay: () => Effect.void,
    inspect: () => Effect.succeed({ status: 'alive' as const }),
    listSessions: Effect.succeed([]),
    kill: () => Effect.succeed({ terminated: true }),
    ...overrides,
  } satisfies PtyBackendShape;
}

function repositoryLayer(dataRoot: string) {
  const directory = Layer.succeed(DataDirectory, makeTestDataDirectory(dataRoot));
  const database = RuntimeDatabaseLive.pipe(Layer.provide(directory));
  return Layer.mergeAll(database, PtyRepositoryLive.pipe(Layer.provide(database)));
}

function serviceLayer(dataRoot: string, catalog: ReturnType<typeof fakeBackendCatalog>) {
  const directory = Layer.succeed(DataDirectory, makeTestDataDirectory(dataRoot));
  const database = RuntimeDatabaseLive.pipe(Layer.provide(directory));
  const repository = PtyRepositoryLive.pipe(Layer.provide(database));
  const service = PtyServiceLive.pipe(
    Layer.provide(repository),
    Layer.provide(Layer.succeed(PtyBackendCatalog, catalog)),
    Layer.provide(PtyForegroundStateLive),
    Layer.provide(directory),
    Layer.provide(InternalRuntimeEventBusLive),
    Layer.provide(Layer.succeed(UserShell, testUserShell())),
  );
  return Layer.mergeAll(database, repository, service);
}

function seedTmuxRow() {
  return Effect.gen(function* () {
    const repository = yield* PtyRepository;
    const id = yield* repository.createProcessMetadata({
      command: 'pnpm',
      args: ['dev'],
      cwd: '/repo/isagi',
    });
    yield* repository.updateBackendMetadata({
      ptyProcessId: id,
      backend: 'tmux',
      backendRefJson: JSON.stringify({
        schemaVersion: 1,
        backend: 'tmux',
        sessionName: `isagi_test_${id}`,
      }),
      logMode: 'none',
      logPath: null,
    });
    yield* repository.transitionProcess({
      ptyProcessId: id,
      status: 'running',
      statusReason: null,
    });
    return id;
  });
}

function withNodePtyConfigured<A, E>(
  dataRoot: string,
  tmux: PtyBackendShape,
  body: (ptyProcessId: number) => Effect.Effect<A, E, PtyService | PtyRepositoryService>,
) {
  const catalog = fakeBackendCatalog({
    configured: 'node_pty',
    nodePty: backendStub('node_pty', {
      inspect: () => Effect.die('a node-pty adapter must never touch a tmux incarnation'),
      kill: () => Effect.die('a node-pty adapter must never kill a tmux incarnation'),
      attach: () => Effect.die('a node-pty adapter must never attach a tmux incarnation'),
      replay: () => Effect.die('a node-pty adapter must never replay a tmux incarnation'),
      writeInput: () => Effect.die('a node-pty adapter must never write to a tmux incarnation'),
    }),
    tmux,
  });
  // The row is seeded through a repository-only layer and the service is built
  // afterwards over the same database file, so startup reconciliation meets the
  // row exactly as it would after a real runtime restart.
  const persistence = repositoryLayer(dataRoot);
  return Effect.gen(function* () {
    const ptyProcessId = yield* seedTmuxRow().pipe(Effect.provide(persistence));
    return yield* body(ptyProcessId).pipe(Effect.provide(serviceLayer(dataRoot, catalog)));
  });
}

test('a persisted tmux row stays inspectable while node-pty is configured', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-cross-inspect-'));
  try {
    let inspections = 0;
    const row = await Effect.runPromise(
      withNodePtyConfigured(
        dataRoot,
        backendStub('tmux', {
          inspect: () =>
            Effect.sync(() => {
              inspections += 1;
              return { status: 'alive' as const };
            }),
        }),
        (ptyProcessId) =>
          Effect.gen(function* () {
            const repository = yield* PtyRepository;
            yield* PtyService;
            return yield* repository.findProcess(ptyProcessId);
          }),
      ),
    );

    // The old mismatch branch pinned this row at running/backend_unavailable and
    // never inspected it again.
    assert.ok(row);
    assert.equal(row.status, 'running');
    assert.equal(row.statusReason, null);
    assert.ok(inspections > 0);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('a persisted tmux row plans attachment as live while node-pty is configured', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-cross-plan-'));
  try {
    const plan = await Effect.runPromise(
      withNodePtyConfigured(dataRoot, backendStub('tmux'), (ptyProcessId) =>
        Effect.gen(function* () {
          const pty = yield* PtyService;
          return yield* pty.getAttachmentPlan({ ptyProcessId });
        }),
      ),
    );

    assert.equal(plan.live, true);
    assert.equal(plan.session.backend, 'tmux');
    assert.equal(plan.replaySource, 'backend');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('a persisted tmux row is terminable through its own backend while node-pty is configured', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-cross-terminate-'));
  try {
    const kills: string[] = [];
    const row = await Effect.runPromise(
      withNodePtyConfigured(
        dataRoot,
        backendStub('tmux', {
          kill: (ref) =>
            Effect.sync(() => {
              kills.push(ref.backend);
              return { terminated: true };
            }),
        }),
        (ptyProcessId) =>
          Effect.gen(function* () {
            const pty = yield* PtyService;
            const repository = yield* PtyRepository;
            yield* pty.kill({ ptyProcessId });
            return yield* repository.findProcess(ptyProcessId);
          }),
      ),
    );

    assert.deepEqual(kills, ['tmux']);
    assert.equal(row?.status, 'killed');
    assert.equal(row?.statusReason, 'user_requested');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('backend_unavailable reports the row own adapter being unavailable, not a differing preference', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-cross-unavailable-'));
  try {
    const outcome = await Effect.runPromise(
      withNodePtyConfigured(
        dataRoot,
        backendStub('tmux', {
          available: Effect.succeed(false),
          kill: () => Effect.die('an unavailable adapter must not be asked to kill'),
        }),
        (ptyProcessId) =>
          Effect.gen(function* () {
            const pty = yield* PtyService;
            return yield* pty.kill({ ptyProcessId }).pipe(Effect.either);
          }),
      ),
    );

    assert.ok(Either.isLeft(outcome));
    const error = outcome.left;
    assert.ok(error instanceof PtyServiceError);
    assert.equal(error.code, 'backend_unavailable');
    assert.match(error.message, /tmux is unavailable/);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

// The mirror image is deliberately synthetic. A live node-pty row cannot exist
// under a tmux-configured runtime in production: node-pty incarnations are
// runtime-ephemeral, and startup reconciliation terminalizes every one of them.
// The row is therefore seeded *after* the service is built, rather than by
// weakening that reconciliation. It still proves the thing worth proving — that
// no existing-incarnation operation consults the launch preference.
test('a persisted node-pty row is operated through node-pty while tmux is configured', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-cross-inverse-'));
  try {
    const kills: string[] = [];
    const catalog = fakeBackendCatalog({
      configured: 'tmux',
      nodePty: backendStub('node_pty', {
        kill: (ref) =>
          Effect.sync(() => {
            kills.push(ref.backend);
            return { terminated: true };
          }),
      }),
      tmux: backendStub('tmux', {
        inspect: () => Effect.die('the configured adapter must not touch a node-pty incarnation'),
        kill: () => Effect.die('the configured adapter must not kill a node-pty incarnation'),
      }),
    });

    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const pty = yield* PtyService;
        const repository = yield* PtyRepository;
        const ptyProcessId = yield* repository.createProcessMetadata({
          command: 'bash',
          args: [],
          cwd: '/repo/isagi',
        });
        yield* repository.updateBackendMetadata({
          ptyProcessId,
          backend: 'node_pty',
          backendRefJson: JSON.stringify({
            schemaVersion: 1,
            backend: 'node_pty',
            ptyProcessId,
            pid: 4242,
          }),
          logMode: 'backend_file',
          logPath: join(dataRoot, 'sessions', `${ptyProcessId}.ptylog`),
        });
        yield* repository.transitionProcess({
          ptyProcessId,
          status: 'running',
          statusReason: null,
        });

        const plan = yield* pty.getAttachmentPlan({ ptyProcessId });
        yield* pty.kill({ ptyProcessId });
        return { plan, row: yield* repository.findProcess(ptyProcessId) };
      }).pipe(Effect.provide(serviceLayer(dataRoot, catalog))),
    );

    assert.equal(outcome.plan.live, true);
    assert.equal(outcome.plan.session.backend, 'node_pty');
    assert.deepEqual(kills, ['node_pty']);
    assert.equal(outcome.row?.status, 'killed');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('backend-session GC sweeps every available adapter, not just the configured one', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-cross-sweep-'));
  try {
    const swept: string[] = [];
    const catalog = fakeBackendCatalog({
      configured: 'node_pty',
      nodePty: backendStub('node_pty', {
        collectGarbage: () =>
          Effect.sync(() => {
            swept.push('node_pty');
            return [];
          }),
      }),
      // Backend-only tmux sessions have no row to dispatch from, so the sweep
      // must run tmux collection even on a node-pty-configured runtime.
      tmux: backendStub('tmux', {
        collectGarbage: () =>
          Effect.sync(() => {
            swept.push('tmux');
            return [];
          }),
      }),
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* PtyService;
      }).pipe(Effect.provide(serviceLayer(dataRoot, catalog))),
    );

    assert.deepEqual(swept.sort(), ['node_pty', 'tmux']);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('backend-session GC skips an adapter that is unavailable', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-cross-sweep-skip-'));
  try {
    const swept: string[] = [];
    const catalog = fakeBackendCatalog({
      configured: 'node_pty',
      nodePty: backendStub('node_pty', {
        collectGarbage: () =>
          Effect.sync(() => {
            swept.push('node_pty');
            return [];
          }),
      }),
      tmux: backendStub('tmux', {
        available: Effect.succeed(false),
        collectGarbage: () => Effect.die('an unavailable adapter must not be swept'),
      }),
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* PtyService;
      }).pipe(Effect.provide(serviceLayer(dataRoot, catalog))),
    );

    assert.deepEqual(swept, ['node_pty']);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
