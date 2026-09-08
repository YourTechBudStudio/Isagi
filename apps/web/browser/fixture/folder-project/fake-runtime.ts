import type { ReconciliationFinding, WorkspaceSnapshot } from '@isagi/contracts';

import { queryClient } from '../../../src/lib/query/client.js';
import { workspaceQueryKey } from '../../../src/lib/workspace/query-keys.js';
import {
  DEFAULT_SCENARIO,
  FIXTURE_CONTROL_PLANE,
  restoredSnapshot,
  scenarioById,
  type ScenarioId,
} from './seed.js';

/**
 * The outcome the *next* recheck produces. Named for what the user would
 * observe, not for where it is implemented, because the whole point of the
 * recovery surface is that three observable outcomes stay distinguishable:
 *
 * - `restores`        — the folder is back; the refreshed snapshot swaps the canvas.
 * - `stays_missing`   — Isagi looked and it genuinely is not there.
 * - `reconcile_fails` — the reconcile call itself refused.
 * - `snapshot_fails`  — reconcile succeeded and the *read* that follows failed.
 *
 * The last two are separate on purpose. They are the two stages §7.3 warns
 * about, and they look identical to a surface that reports on the reconcile
 * alone — including the dangerous case where the folder was restored but the
 * read that would have proved it failed. A mock that could only fail in one
 * place would not be able to show that.
 */
export type RecheckOutcome = 'restores' | 'stays_missing' | 'reconcile_fails' | 'snapshot_fails';

export interface FolderProjectFixtureControls {
  readonly setScenario: (id: ScenarioId) => Promise<void>;
  readonly scenario: () => ScenarioId;
  readonly setRecheckOutcome: (outcome: RecheckOutcome) => void;
  readonly recheckOutcome: () => RecheckOutcome;
  /** Hold both recheck stages open, so the pending state can be looked at. */
  readonly setLatency: (ms: number) => void;
  /** Reconcile calls made, newest last — proves a disabled button really is disabled. */
  readonly reconcileCalls: () => readonly (number | null)[];
}

declare global {
  interface Window {
    folderProjectFixture?: FolderProjectFixtureControls;
  }
}

const RUNTIME_ORIGIN = 'http://folder-project-fixture.invalid';

/**
 * A runtime made of one object and a `fetch` stub, in the shape
 * {@link ../rail-reorder/fake-runtime} established.
 *
 * It answers the production workspace, control-plane, active-context and
 * reconcile endpoints, which is everything the mounted production query stack
 * asks for. Nothing about the *feature* lives here: reconcile applies presence
 * for real and the snapshot read is a real read, so the recovery prototype
 * exercises the same two-stage sequence §7.3 specifies rather than a rehearsal
 * of it. Steering is through `window.folderProjectFixture`, so the on-screen
 * controls and a Playwright spec drive exactly the same switches.
 */
export function installFakeRuntime() {
  let scenarioId: ScenarioId = DEFAULT_SCENARIO;
  let snapshot: WorkspaceSnapshot = scenarioById(scenarioId).snapshot;
  let outcome: RecheckOutcome = 'restores';
  let latency = 0;
  const reconcileCalls: (number | null)[] = [];
  /**
   * Bumped by every scenario reset. A request captures it before it waits and
   * checks it before it writes, so work started under an older run can never
   * apply to a newer one.
   *
   * Needed because the latency control exists precisely so a human can sit in
   * the pending state, and the scenario chips are how they navigate — so
   * "start a slow restore, then reset" is an ordinary thing to do here, not a
   * contrived one. Without the guard that restore lands on the *fresh*
   * snapshot and quietly un-misses a project the reset had just restored to
   * missing.
   */
  let generation = 0;

  window.isagi = { getRuntimeUrl: () => Promise.resolve(RUNTIME_ORIGIN) };
  window.folderProjectFixture = {
    setScenario: async (id) => {
      generation += 1;
      scenarioId = id;
      snapshot = scenarioById(id).snapshot;
      reconcileCalls.length = 0;
      await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
    },
    scenario: () => scenarioId,
    setRecheckOutcome: (next) => {
      outcome = next;
    },
    recheckOutcome: () => outcome,
    setLatency: (ms) => {
      latency = ms;
    },
    reconcileCalls: () => reconcileCalls,
  };

  const realFetch = window.fetch.bind(window);

  window.fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      window.location.origin,
    );
    if (url.origin !== RUNTIME_ORIGIN) return realFetch(input as RequestInfo, init);

    const method = init?.method ?? 'GET';
    const path = url.pathname.replace('/api/v1', '');

    if (method === 'GET' && path === '/control-plane') return success(FIXTURE_CONTROL_PLANE);

    // The active context is served empty and accepted without storing: this page
    // opens on a scenario's own selection, and a persisted one would fight it.
    if (path === '/workspace/active-context') {
      return success({ activeContext: { projectId: null, worktreeId: null } });
    }

    if (method === 'GET' && path === '/workspace') {
      if (latency > 0) await delay(latency);
      // The failure that matters most: reconcile said yes and the read that
      // would have established the verdict said no.
      if (outcome === 'snapshot_fails' && reconcileCalls.length > 0) {
        return failure('The fixture runtime dropped the read.', 'read_workspace');
      }
      return success(snapshot);
    }

    if (method === 'POST' && path === '/workspace/reconcile') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { projectId?: number | null };
      const projectId = body.projectId ?? null;
      const requestGeneration = generation;
      reconcileCalls.push(projectId);
      if (latency > 0) await delay(latency);

      // Superseded by a scenario reset while it waited. Answer honestly — it
      // changed nothing — rather than writing into a run it does not belong to.
      // Only the *write* needs this guard: the workspace read below resolves
      // `snapshot` after its own wait, so a late read already returns whatever
      // the current run holds.
      if (requestGeneration !== generation) {
        return success({ findings: [] as readonly ReconciliationFinding[] });
      }

      if (outcome === 'reconcile_fails') {
        return failure('The fixture runtime refused to reconcile.', 'reconcile_workspace');
      }

      // Presence is applied for real, so the read that follows *converges* on
      // the restored project rather than being told the answer separately.
      // `stays_missing` and `snapshot_fails` leave the snapshot alone, which is
      // exactly what a folder that is still absent produces.
      if (outcome === 'restores' && projectId !== null) {
        const before = snapshot;
        snapshot = restoredSnapshot(snapshot, projectId);
        return success({ findings: findingsFor(before, snapshot, projectId) });
      }

      // A repeat sweep over a folder that is still missing reports nothing at
      // all — which is why the verdict can never be read off the findings list.
      return success({ findings: [] as readonly ReconciliationFinding[] });
    }

    // Everything below exists because the production components mounted on this
    // page ask for it. Each answer is an explicit, valid, *honest* one — an
    // empty catalog rather than a suppressed error — so the surfaces render the
    // state they would render against a real runtime with nothing configured.

    // The status strip's command region. `configured` with no commands is what a
    // worktree that configures none genuinely returns, and is what makes the
    // strip read "Nothing running here yet." beside the ref tag under test.
    const commandsMatch = /^\/worktrees\/(\d+)\/commands$/.exec(path);
    if (method === 'GET' && commandsMatch) {
      return success({
        status: 'configured',
        worktreeId: Number(commandsMatch[1]),
        commands: [],
        removedCommands: [],
      });
    }

    // The palette reads the active surface's detail to build a workflow launch
    // context. One pane, no session: enough to be a valid surface, nothing that
    // would put a live process on a page that has no runtime behind it.
    const surfaceMatch = /^\/surfaces\/(\d+)$/.exec(path);
    const surfaceWorktreeId = surfaceMatch
      ? worktreeIdForSurface(snapshot, Number(surfaceMatch[1]))
      : null;
    if (method === 'GET' && surfaceMatch && surfaceWorktreeId !== null) {
      const surfaceId = Number(surfaceMatch[1]);
      const paneId = surfaceId * 100 + 1;
      return success({
        id: surfaceId,
        worktreeId: surfaceWorktreeId,
        title: 'agent',
        layout: { kind: 'leaf', nodeId: `pane-${paneId}`, paneId, collapsed: false },
        activePaneId: paneId,
        panes: [{ id: paneId, surfaceId, title: 'agent', sortOrder: 0, session: null }],
      });
    }

    // No workflows are discoverable here. An empty list is a real answer; a 404
    // would have put a discovery-failure row in the palette next to the two
    // commands this page exists to look at.
    if (method === 'POST' && path === '/workflows/descriptors') {
      return success({ workflows: [] });
    }

    return json(404, {
      error: {
        code: 'api_route_not_found',
        status: 404,
        message: `No fixture route for ${method} ${path}`,
        requestId: 'folder-project-fixture',
      },
    });
  };
}

function findingsFor(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  projectId: number,
): readonly ReconciliationFinding[] {
  const was = before.projects.find((project) => project.id === projectId);
  const now = after.projects.find((project) => project.id === projectId);
  if (!was || !now || was.status !== 'missing' || now.status !== 'present') return [];
  return [{ kind: 'project_restored', projectId, path: now.rootPath }];
}

function success(data: unknown) {
  return json(200, { data, meta: { requestId: 'folder-project-fixture' } });
}

/**
 * A real refusal envelope, not a generic one.
 *
 * `runtime_database_failed` is in the declared error union of *both* endpoints
 * the recheck touches, so the web layer decodes it as a typed failure and picks
 * its own copy — which means the failure line on screen is the sentence a user
 * would genuinely see. An untyped envelope would fall through to "Isagi couldn't
 * read the response", and the mock would be judging a message the app does not
 * actually produce here.
 */
function failure(message: string, operation: string) {
  return json(500, {
    error: {
      code: 'runtime_database_failed',
      status: 500,
      message,
      requestId: 'folder-project-fixture',
      data: { operation },
    },
  });
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Which worktree a surface belongs to, read from the snapshot the page is
 * currently serving rather than recomputed from an id convention, so a surface
 * detail can never disagree with the workspace the rail is rendering.
 */
function worktreeIdForSurface(snapshot: WorkspaceSnapshot, surfaceId: number): number | null {
  for (const project of snapshot.projects) {
    if (project.status !== 'present') continue;
    for (const worktree of project.worktrees) {
      if (worktree.surfaces.some((surface) => surface.id === surfaceId)) return worktree.id;
    }
  }
  // Falls through to the 404 below rather than inventing a worktree id. A
  // surface the current snapshot does not contain is a genuine miss, and saying
  // so beats emitting a detail that would fail its own contract decode.
  return null;
}
