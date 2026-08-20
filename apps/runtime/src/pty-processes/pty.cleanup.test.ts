import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Layer } from 'effect';

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
  PtyKillError,
  PtyInspectError,
  type PtyBackend as PtyBackendShape,
  type PtyBackendName,
  type PtyProcessStatus,
} from './types.js';

// `cleanupProcess` is the one operation both durable cleanup owners drive: boot
// convergence and the worktree-deletion audit. What it must never do is guess.
// Every case where process truth could not be established has to reach the
// caller as a failure, because both callers make irreversible decisions — one
// writes a command's terminal outcome, the other cascades a worktree away.

function testUserShell(): UserShellService {
  return {
    environment: {
      _tag: 'Available' as const,
      values: { HOME: '/home/developer', PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' },
    },
    run: () => Effect.die('cleanup tests do not run user-shell commands.'),
  };
}

function backendStub(name: PtyBackendName, overrides: Partial<PtyBackendShape> = {}) {
  return {
    name,
    available: Effect.succeed(true),
    launch: () => Effect.die(`${name} launch is not expected here`),
    writeInput: () => Effect.void,
    attach: () => Effect.die(`${name} attach is not expected here`),
    replay: () => Effect.void,
    inspect: () => Effect.succeed({ status: 'alive' as const }),
    listSessions: Effect.succeed([]),
    kill: () => Effect.succeed({ terminated: true }),
    ...overrides,
  } satisfies PtyBackendShape;
}

// Never-touched adapter for the backend that did not create the row. Any call
// through it is a dispatch bug, not a test failure to be interpreted.
function forbiddenBackend(name: PtyBackendName) {
  return backendStub(name, {
    inspect: () => Effect.die(`${name} must never inspect another backend's incarnation`),
    kill: () => Effect.die(`${name} must never kill another backend's incarnation`),
    available: Effect.sync(() => {
      throw new Error(`${name} must never be probed for another backend's incarnation`);
    }),
  });
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

function seedRow(input: {
  readonly backend: PtyBackendName;
  readonly status: PtyProcessStatus;
  readonly backendRefJson?: string | undefined;
}) {
  return Effect.gen(function* () {
    const repository = yield* PtyRepository;
    const id = yield* repository.createProcessMetadata({
      command: 'pnpm',
      args: ['dev'],
      cwd: '/repo/isagi',
    });
    yield* repository.updateBackendMetadata({
      ptyProcessId: id,
      backend: input.backend,
      backendRefJson:
        input.backendRefJson ??
        (input.backend === 'tmux'
          ? JSON.stringify({ schemaVersion: 1, backend: 'tmux', sessionName: `isagi_test_${id}` })
          : JSON.stringify({ schemaVersion: 1, backend: 'node_pty', ptyProcessId: id, pid: 4242 })),
      logMode: 'none',
      logPath: null,
    });
    if (input.status !== 'starting') {
      yield* repository.transitionProcess({
        ptyProcessId: id,
        status: input.status,
        statusReason: input.status === 'failed' ? 'backend_process_missing' : null,
      });
    }
    return id;
  });
}

// The row is seeded *inside* the built service so a node-pty row can be
// nonterminal: startup reconciliation deliberately terminal-izes every
// surviving node-pty row, so seeding one before construction would only ever
// reproduce the ephemeral-loss case.
function withCleanup<A, E>(
  dataRoot: string,
  catalog: ReturnType<typeof fakeBackendCatalog>,
  body: (context: {
    readonly pty: PtyService;
    readonly repository: PtyRepositoryService;
  }) => Effect.Effect<A, E, PtyRepositoryService | PtyService>,
) {
  return Effect.gen(function* () {
    const pty = yield* PtyService;
    const repository = yield* PtyRepository;
    return yield* body({ pty, repository });
  }).pipe(Effect.provide(serviceLayer(dataRoot, catalog)));
}

function withTempRoot(label: string, run: (dataRoot: string) => Promise<void>) {
  return async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), `isagi-pty-cleanup-${label}-`));
    try {
      await run(dataRoot);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  };
}

const nodePtyAndTmux = (tmux: PtyBackendShape) =>
  fakeBackendCatalog({ configured: 'node_pty', nodePty: forbiddenBackend('node_pty'), tmux });

test(
  'a missing row is already terminal and touches no backend',
  withTempRoot('absent', async (dataRoot) => {
    const outcome = await Effect.runPromise(
      withCleanup(dataRoot, nodePtyAndTmux(forbiddenBackend('tmux')), ({ pty }) =>
        pty.cleanupProcess({ ptyProcessId: 9999, reason: 'runtime_shutdown' }),
      ),
    );
    assert.equal(outcome, 'already_terminal');
  }),
);

test(
  'a terminal row is trusted without the absence check and probed with it',
  withTempRoot('terminal-trust', async (dataRoot) => {
    let kills = 0;
    const results = await Effect.runPromise(
      withCleanup(
        dataRoot,
        nodePtyAndTmux(
          backendStub('tmux', {
            kill: () =>
              Effect.sync(() => {
                kills += 1;
                return { terminated: false };
              }),
          }),
        ),
        ({ pty }) =>
          Effect.gen(function* () {
            const ptyProcessId = yield* seedRow({ backend: 'tmux', status: 'exited' });
            const trusted = yield* pty.cleanupProcess({ ptyProcessId, reason: 'user_requested' });
            const gated = yield* pty.cleanupProcess({
              ptyProcessId,
              reason: 'user_requested',
              ensureBackendAbsence: true,
            });
            return { trusted, gated };
          }),
      ),
    );

    assert.equal(results.trusted, 'already_terminal');
    // Verified absence, not a failure: the backend looked and found nothing.
    assert.equal(results.gated, 'already_terminal');
    assert.equal(kills, 1, 'only the gated call may reach the backend');
  }),
);

test(
  'a gating kill that finds a live session behind a terminal row reports it',
  withTempRoot('terminal-liar', async (dataRoot) => {
    const result = await Effect.runPromise(
      withCleanup(
        dataRoot,
        nodePtyAndTmux(backendStub('tmux', { kill: () => Effect.succeed({ terminated: true }) })),
        ({ pty, repository }) =>
          Effect.gen(function* () {
            const ptyProcessId = yield* seedRow({ backend: 'tmux', status: 'failed' });
            const outcome = yield* pty.cleanupProcess({
              ptyProcessId,
              reason: 'user_requested',
              ensureBackendAbsence: true,
            });
            return { outcome, row: yield* repository.findProcess(ptyProcessId) };
          }),
      ),
    );

    assert.equal(result.outcome, 'terminated');
    // The row's first terminal fact stands: this attempt learned that a session
    // existed, not that the recorded death was wrong.
    assert.equal(result.row?.status, 'failed');
    assert.equal(result.row?.statusReason, 'backend_process_missing');
  }),
);

test(
  'every observable gating failure propagates instead of allowing a cascade',
  withTempRoot('terminal-gate-failures', async (dataRoot) => {
    const unavailable = await Effect.runPromise(
      Effect.flip(
        withCleanup(
          dataRoot,
          nodePtyAndTmux(backendStub('tmux', { available: Effect.succeed(false) })),
          ({ pty }) =>
            Effect.gen(function* () {
              const ptyProcessId = yield* seedRow({ backend: 'tmux', status: 'exited' });
              return yield* pty.cleanupProcess({
                ptyProcessId,
                reason: 'user_requested',
                ensureBackendAbsence: true,
              });
            }),
        ),
      ),
    );
    assert.equal(unavailable._tag, 'PtyServiceError');
    assert.equal(unavailable.code, 'backend_unavailable');

    const undecodable = await Effect.runPromise(
      Effect.flip(
        withCleanup(dataRoot, nodePtyAndTmux(backendStub('tmux')), ({ pty }) =>
          Effect.gen(function* () {
            const ptyProcessId = yield* seedRow({
              backend: 'tmux',
              status: 'exited',
              backendRefJson: '{"schemaVersion":1,"backend":"tmux"}',
            });
            return yield* pty.cleanupProcess({
              ptyProcessId,
              reason: 'user_requested',
              ensureBackendAbsence: true,
            });
          }),
        ),
      ),
    );
    assert.equal(undecodable._tag, 'PtyServiceError');
    assert.equal(undecodable.code, 'backend_session_missing');

    const killError = await Effect.runPromise(
      Effect.flip(
        withCleanup(
          dataRoot,
          nodePtyAndTmux(
            backendStub('tmux', {
              kill: () => Effect.fail(new PtyKillError({ cause: new Error('tmux is unusable') })),
            }),
          ),
          ({ pty }) =>
            Effect.gen(function* () {
              const ptyProcessId = yield* seedRow({ backend: 'tmux', status: 'exited' });
              return yield* pty.cleanupProcess({
                ptyProcessId,
                reason: 'user_requested',
                ensureBackendAbsence: true,
              });
            }),
        ),
      ),
    );
    assert.equal(killError._tag, 'PtyKillError');
  }),
);

test(
  'a nonterminal row whose process is missing is classified by its own backend',
  withTempRoot('missing', async (dataRoot) => {
    const result = await Effect.runPromise(
      withCleanup(
        dataRoot,
        fakeBackendCatalog({
          configured: 'node_pty',
          nodePty: backendStub('node_pty', {
            inspect: () => Effect.succeed({ status: 'missing' as const }),
          }),
          tmux: backendStub('tmux', {
            inspect: () => Effect.succeed({ status: 'missing' as const }),
          }),
        }),
        ({ pty, repository }) =>
          Effect.gen(function* () {
            const tmuxId = yield* seedRow({ backend: 'tmux', status: 'running' });
            const nodeId = yield* seedRow({ backend: 'node_pty', status: 'running' });
            const tmuxOutcome = yield* pty.cleanupProcess({
              ptyProcessId: tmuxId,
              reason: 'runtime_shutdown',
            });
            const nodeOutcome = yield* pty.cleanupProcess({
              ptyProcessId: nodeId,
              reason: 'runtime_shutdown',
            });
            return {
              tmuxOutcome,
              nodeOutcome,
              tmuxRow: yield* repository.findProcess(tmuxId),
              nodeRow: yield* repository.findProcess(nodeId),
            };
          }),
      ),
    );

    assert.equal(result.tmuxOutcome, 'already_terminal');
    assert.equal(result.tmuxRow?.status, 'failed');
    assert.equal(result.tmuxRow?.statusReason, 'backend_process_missing');

    assert.equal(result.nodeOutcome, 'already_terminal');
    assert.equal(result.nodeRow?.status, 'failed');
    // A node-pty process cannot outlive the runtime, so its absence is an
    // ephemeral loss rather than a backend that lost track of a process.
    assert.equal(result.nodeRow?.statusReason, 'runtime_ephemeral_lost');
  }),
);

test(
  'an unavailable adapter fails a nonterminal cleanup rather than declaring the process gone',
  withTempRoot('nonterminal-unavailable', async (dataRoot) => {
    const error = await Effect.runPromise(
      Effect.flip(
        withCleanup(
          dataRoot,
          nodePtyAndTmux(
            backendStub('tmux', {
              inspect: () =>
                Effect.fail(new PtyInspectError({ cause: new Error('tmux binary is gone') })),
            }),
          ),
          ({ pty, repository }) =>
            Effect.gen(function* () {
              const ptyProcessId = yield* seedRow({ backend: 'tmux', status: 'running' });
              const outcome = yield* pty.cleanupProcess({
                ptyProcessId,
                reason: 'runtime_shutdown',
              });
              // Unreachable: proves the row was not terminal-ized on the way out.
              const row = yield* repository.findProcess(ptyProcessId);
              return { outcome, row };
            }),
        ),
      ),
    );

    assert.equal(error._tag, 'PtyServiceError');
    assert.equal(error.code, 'backend_unavailable');
  }),
);

test(
  'a live incarnation is terminated through its persisted backend',
  withTempRoot('alive', async (dataRoot) => {
    let killedRefs: string[] = [];
    const result = await Effect.runPromise(
      withCleanup(
        dataRoot,
        nodePtyAndTmux(
          backendStub('tmux', {
            inspect: () => Effect.succeed({ status: 'alive' as const }),
            kill: (ref) =>
              Effect.sync(() => {
                killedRefs.push(ref.backend === 'tmux' ? ref.sessionName : 'wrong-backend');
                return { terminated: true };
              }),
          }),
        ),
        ({ pty, repository }) =>
          Effect.gen(function* () {
            const ptyProcessId = yield* seedRow({ backend: 'tmux', status: 'running' });
            const outcome = yield* pty.cleanupProcess({
              ptyProcessId,
              reason: 'runtime_shutdown',
            });
            return { outcome, row: yield* repository.findProcess(ptyProcessId) };
          }),
      ),
    );

    assert.equal(result.outcome, 'terminated');
    assert.equal(result.row?.status, 'killed');
    assert.equal(result.row?.statusReason, 'runtime_shutdown');
    assert.equal(killedRefs.length, 1);
    assert.ok(killedRefs[0]?.startsWith('isagi_test_'));
  }),
);

test(
  'an incarnation that ends between inspection and kill writes no terminal fact of its own',
  withTempRoot('absent-race', async (dataRoot) => {
    const result = await Effect.runPromise(
      withCleanup(
        dataRoot,
        nodePtyAndTmux(
          backendStub('tmux', {
            inspect: () => Effect.succeed({ status: 'alive' as const }),
            // Verified absence at kill time: the session ended on its own.
            kill: () => Effect.succeed({ terminated: false }),
          }),
        ),
        ({ pty, repository }) =>
          Effect.gen(function* () {
            const ptyProcessId = yield* seedRow({ backend: 'tmux', status: 'running' });
            const outcome = yield* pty.cleanupProcess({
              ptyProcessId,
              reason: 'runtime_shutdown',
            });
            return { outcome, row: yield* repository.findProcess(ptyProcessId) };
          }),
      ),
    );

    // The caller is entitled to stop worrying about this incarnation, but no
    // cause is bound to it: its own terminal fact stays owned by whatever
    // actually ended it.
    assert.equal(result.outcome, 'already_terminal');
    assert.equal(result.row?.status, 'running');
    assert.equal(result.row?.statusReason, null);
  }),
);
