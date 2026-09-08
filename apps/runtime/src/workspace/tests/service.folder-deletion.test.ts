import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after as afterAll, describe } from 'node:test';

import { eq } from 'drizzle-orm';
import { Effect } from 'effect';

import type { DurableSessionIdentity } from '@isagi/contracts';

import { AgentSessionService } from '../../agent-sessions/index.js';
import { CommandError, type CommandServiceShape } from '../../commands/index.js';
import type { GitService } from '../../git/index.js';
import { createFixtureWorkspace } from '../../git/tests/fixtures.js';
import { RuntimeDatabase } from '../../persistence/index.js';
import {
  agentSessions,
  projects,
  surfacePanes,
  terminalSessions,
  worktrees,
  worktreeSurfaces,
} from '../../persistence/schema.js';
import type {
  InternalRuntimeEvent,
  InternalRuntimeEventBusService,
} from '../../runtime-events/index.js';
import { realSessionCreationLayer } from '../../session-restore/test-support.js';
import { SurfaceService } from '../../surfaces/index.js';
import { TerminalSessionService } from '../../terminal-sessions/index.js';
import { WorkspaceRepository } from '../workspace.repository.js';
import { WorkspaceError, WorkspaceService } from '../workspace.service.js';
import { liveWorkspaceLayer } from './live-workspace-support.js';
import { directoryTree } from './test-support.js';

/**
 * Removing a folder project removes Isagi's record of it and nothing else.
 *
 * The two claims that need real state to mean anything are here, and both are
 * made against a genuine folder on disk and genuine dependent rows created
 * through their owning services:
 *
 *   - a successful removal cascades the durable rows away, announces the
 *     sessions it destroyed *after* that commit, and leaves every byte in the
 *     user's folder alone;
 *   - a refused command cleanup removes nothing at all — not the project, not
 *     one dependent row — and says why.
 *
 * `service.command-cleanup-gate.test.ts` owns the gate's behaviour across the
 * other entry points, with doubles. This suite is deliberately not a second
 * copy of that: it exists to show the gate holding over rows that actually
 * exist, which a double cannot demonstrate.
 */

const fixtures = createFixtureWorkspace('folder-deletion');
afterAll(() => {
  fixtures.cleanup();
});

/** Git must not be reachable from any part of removing a folder project. */
const dyingGit: GitService = {
  run: () => Effect.die('git must not run while removing a folder project'),
};

/**
 * An event bus that records what was published and, for each event, whether the
 * project row still existed at that moment.
 *
 * The ordering claim is "the announcement follows the commit", and that is a
 * claim about database state at publication time — not about wall-clock order,
 * which would be a weaker instrument reading the same run.
 */
function inspectingEventBus() {
  const observations: Array<{
    readonly event: InternalRuntimeEvent;
    readonly projectRowStillPresent: boolean | null;
  }> = [];
  const probe = { projectRowStillPresent: null as Effect.Effect<boolean> | null };
  return {
    observations,
    probe,
    service: {
      publish: (event: InternalRuntimeEvent) =>
        Effect.gen(function* () {
          const projectRowStillPresent = probe.projectRowStillPresent
            ? yield* probe.projectRowStillPresent
            : null;
          observations.push({ event, projectRowStillPresent });
        }),
      subscribe: () => Effect.succeed({ take: Effect.never, unsubscribe: Effect.void }),
    } satisfies InternalRuntimeEventBusService,
  };
}

function recordingCommands(record: string[], failCleanup: boolean): Partial<CommandServiceShape> {
  return {
    cleanupBeforeWorktreeDelete: (input: { readonly worktreeId: number }) =>
      Effect.gen(function* () {
        record.push(`cleanup:${input.worktreeId}`);
        if (failCleanup) {
          return yield* Effect.fail(
            new CommandError({
              code: 'command_action_failed',
              message: `Could not account for 1 command process(es) while cleaning up worktree ${input.worktreeId}.`,
              worktreeId: input.worktreeId,
            }),
          );
        }
      }),
  };
}

/** Every durable row this suite cares about, read straight from the tables. */
const readRows = Effect.gen(function* () {
  const database = yield* RuntimeDatabase;
  return yield* database.use('test_read_folder_deletion_rows', (db) => ({
    projects: db.select().from(projects).orderBy(projects.id).all(),
    worktrees: db.select().from(worktrees).orderBy(worktrees.id).all(),
    surfaces: db.select().from(worktreeSurfaces).orderBy(worktreeSurfaces.id).all(),
    panes: db.select().from(surfacePanes).orderBy(surfacePanes.id).all(),
    agentSessions: db.select().from(agentSessions).orderBy(agentSessions.id).all(),
    terminalSessions: db.select().from(terminalSessions).orderBy(terminalSessions.id).all(),
  }));
});

/**
 * A folder project with real nested contents, a real environment, and real
 * surfaces, panes, and pane-bound sessions.
 *
 * Sessions are created through `SurfaceService`, not seeded, so the rows the
 * cascade has to remove are the rows the product would actually have made.
 */
async function seedFolderProject(name: string) {
  const dataRoot = mkdtempSync(join(tmpdir(), `isagi-${name}-`));
  const projectPath = fixtures.directory(name);
  mkdirSync(join(projectPath, 'src', 'nested'), { recursive: true });
  writeFileSync(join(projectPath, 'src', 'main.ts'), 'export const main = 1;\n');
  writeFileSync(join(projectPath, 'src', 'nested', 'deep.txt'), 'sentinel\n');
  writeFileSync(join(projectPath, 'notes.md'), '# notes\n');

  const registered = await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* WorkspaceService;
      const repository = yield* WorkspaceRepository;
      const added = yield* service.registerProject({ path: projectPath });
      const worktree = (yield* repository.listWorktrees).find(
        (row) => row.projectId === added.projectId,
      );
      if (!worktree) throw new Error('Expected the folder project to own an environment.');
      return { projectId: added.projectId, worktreeId: worktree.id };
    }).pipe(Effect.provide(liveWorkspaceLayer(dataRoot, {}))),
  );

  const sessions = await Effect.runPromise(
    Effect.gen(function* () {
      const surfaces = yield* SurfaceService;
      const agents = yield* AgentSessionService;
      const terminals = yield* TerminalSessionService;

      const agentSurface = yield* surfaces.createSinglePaneSurface({
        worktreeId: registered.worktreeId,
        titleBase: 'Agent',
      });
      const agentBound = yield* surfaces.createPaneSession({
        worktreeId: registered.worktreeId,
        create: { kind: 'agent_session', paneId: agentSurface.paneId, harness: 'pi' },
      });
      const terminalSurface = yield* surfaces.createSinglePaneSurface({
        worktreeId: registered.worktreeId,
        titleBase: 'Terminal',
      });
      const terminalBound = yield* surfaces.createPaneSession({
        worktreeId: registered.worktreeId,
        create: { kind: 'terminal_session', paneId: terminalSurface.paneId },
      });
      if (agentBound.session.kind !== 'agent_session') throw new Error('Expected an agent pane.');
      if (terminalBound.session.kind !== 'terminal_session')
        throw new Error('Expected a terminal pane.');

      // Give both a live process, so removal has something to announce.
      yield* agents.ensureActivePtyProcess(agentBound.session.agentSessionId);
      yield* terminals.ensureActivePtyProcess(terminalBound.session.terminalSessionId);

      return {
        agentSessionId: agentBound.session.agentSessionId,
        terminalSessionId: terminalBound.session.terminalSessionId,
      };
    }).pipe(
      Effect.provide(realSessionCreationLayer(dataRoot, { ptyLaunches: [], harnessLaunches: [] })),
    ),
  );

  return {
    dataRoot,
    projectPath,
    ...registered,
    ...sessions,
    contentsBefore: directoryTree(projectPath),
    cleanup: () => rmSync(dataRoot, { recursive: true, force: true }),
  };
}

describe('removing a folder project', () => {
  test('cleans up, cascades, announces the destroyed sessions after the commit, and leaves the folder alone', async () => {
    const seeded = await seedFolderProject('folder-delete-success');
    const record: string[] = [];
    const bus = inspectingEventBus();

    try {
      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* WorkspaceService;
          const database = yield* RuntimeDatabase;
          const before = yield* readRows;

          // Read inside the publish, so the ordering claim is about committed
          // state rather than about the order two arrays were appended to.
          bus.probe.projectRowStillPresent = database
            .use('test_probe_project_row', (db) =>
              db.select().from(projects).where(eq(projects.id, seeded.projectId)).all(),
            )
            .pipe(
              Effect.map((rows) => rows.length > 0),
              Effect.orDie,
            );

          const deleted = yield* service.deleteProject(seeded.projectId);
          return { before, deleted, after: yield* readRows };
        }).pipe(
          Effect.provide(
            liveWorkspaceLayer(seeded.dataRoot, {
              decorateGit: () => dyingGit,
              commands: recordingCommands(record, false),
              internalEvents: bus.service,
            }),
          ),
        ),
      );

      // The fixture was real before the delete, or nothing below means anything.
      assert.equal(outcome.before.projects.length, 1);
      assert.equal(outcome.before.worktrees.length, 1);
      assert.equal(outcome.before.surfaces.length, 2);
      assert.equal(outcome.before.panes.length, 2);
      assert.equal(outcome.before.agentSessions.length, 1);
      assert.equal(outcome.before.terminalSessions.length, 1);

      assert.deepEqual(outcome.deleted, { projectId: seeded.projectId, deleted: true });

      // Cleanup ran, once, for the singleton environment.
      assert.deepEqual(record, [`cleanup:${seeded.worktreeId}`]);

      // Every dependent row went with the project.
      assert.deepEqual(outcome.after, {
        projects: [],
        worktrees: [],
        surfaces: [],
        panes: [],
        agentSessions: [],
        terminalSessions: [],
      });

      // Both destroyed sessions were announced, and each announcement was made
      // when the project row was already gone.
      const deletions = bus.observations.filter(
        (observation) => observation.event.type === 'durable_session_deleted',
      );
      assert.deepEqual(
        deletions.map(
          (observation) => (observation.event as { identity: DurableSessionIdentity }).identity,
        ),
        [
          {
            kind: 'agent_session',
            sessionId: seeded.agentSessionId,
            worktreeId: seeded.worktreeId,
          },
          {
            kind: 'terminal_session',
            sessionId: seeded.terminalSessionId,
            worktreeId: seeded.worktreeId,
          },
        ],
      );
      assert.deepEqual(
        deletions.map((observation) => observation.projectRowStillPresent),
        [false, false],
      );

      // Publishing is where this suite's claim stops. Nothing here establishes
      // that a subscriber handled the event or that any process was disposed:
      // `runtime-events/projection.service.ts` forwards it to the public bus and
      // is not in this graph, and `session-gc.service.ts` publishes the same
      // event for its own reasons and is not involved at all.

      // The user's folder is untouched, contents included.
      assert.deepEqual(directoryTree(seeded.projectPath), seeded.contentsBefore);
    } finally {
      seeded.cleanup();
    }
  });

  test('a refused command cleanup removes nothing and keeps its diagnostic', async () => {
    const seeded = await seedFolderProject('folder-delete-refused');
    const record: string[] = [];
    const bus = inspectingEventBus();

    try {
      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* WorkspaceService;
          const before = yield* readRows;
          const failure = yield* Effect.either(service.deleteProject(seeded.projectId));
          return { before, failure, after: yield* readRows };
        }).pipe(
          Effect.provide(
            liveWorkspaceLayer(seeded.dataRoot, {
              decorateGit: () => dyingGit,
              commands: recordingCommands(record, true),
              internalEvents: bus.service,
            }),
          ),
        ),
      );

      assert.equal(outcome.failure._tag, 'Left');
      const error = outcome.failure._tag === 'Left' ? outcome.failure.left : null;
      assert.ok(error instanceof WorkspaceError);
      // The existing mapping, unchanged: no reason literal was invented here.
      assert.equal(error.code, 'command_cleanup_failed');
      assert.equal(error.projectId, seeded.projectId);
      assert.equal(error.worktreeId, seeded.worktreeId);
      assert.match(error.message, /Could not stop running commands for worktree/);
      // The command domain's own explanation survives as the cause, which is
      // what makes a stuck removal reportable.
      assert.ok(error.cause instanceof CommandError);
      assert.match(String(error.cause.message), /Could not account for 1 command process/);

      assert.deepEqual(record, [`cleanup:${seeded.worktreeId}`]);

      // Nothing was removed. Compared as whole row sets, so a partial cascade
      // shows up rather than only a missing project.
      assert.deepEqual(outcome.after, outcome.before);
      assert.equal(outcome.after.projects.length, 1);
      assert.equal(outcome.after.agentSessions.length, 1);
      assert.equal(outcome.after.terminalSessions.length, 1);

      // A refusal announces nothing: a session deletion event here would tell
      // every connected client to drop a session that still exists.
      assert.deepEqual(
        bus.observations.filter(
          (observation) => observation.event.type === 'durable_session_deleted',
        ),
        [],
      );

      assert.deepEqual(directoryTree(seeded.projectPath), seeded.contentsBefore);
    } finally {
      seeded.cleanup();
    }
  });
});
