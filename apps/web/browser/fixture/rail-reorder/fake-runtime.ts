import type { WorkspaceSnapshot } from '@isagi/contracts';

import { moveBefore } from '../../../src/lib/workspace/rail-order.js';
import { FIXTURE_SNAPSHOT } from './seed.js';

/**
 * A runtime made of one object and a `fetch` stub.
 *
 * The fixture mounts the production `Rail`, which means the production query,
 * the production runtime client, and the production reorder commit all run for
 * real. The only thing replaced is the process at the other end of the wire — so
 * a Playwright drag exercises optimistic projection, the `PUT`, the refetch, and
 * rollback exactly as the app does, rather than a rehearsal of them.
 *
 * It applies moves for real, too. The three order endpoints rewrite this
 * snapshot with the same anchored-move semantics the runtime uses, so the
 * refetch that follows a successful drag *converges* on the new order instead of
 * quietly restoring the old one and hiding a bug.
 *
 * Tests steer it through `window.railFixture` rather than through on-screen
 * controls: the rail should be the only thing on this page.
 */
export interface RailFixtureControls {
  /** Reject the next order write, so rollback and its notice can be observed. */
  readonly failNextWrite: () => void;
  /** Hold every order write open for `ms`, widening the in-flight window. */
  readonly setWriteDelay: (ms: number) => void;
  /** Current server-side order, for asserting what actually persisted. */
  readonly order: () => string;
}

declare global {
  interface Window {
    railFixture?: RailFixtureControls;
  }
}

const RUNTIME_ORIGIN = 'http://rail-fixture.invalid';

export function installFakeRuntime() {
  let snapshot: WorkspaceSnapshot = FIXTURE_SNAPSHOT;
  let failNext = false;
  let writeDelay = 0;

  window.isagi = { getRuntimeUrl: () => Promise.resolve(RUNTIME_ORIGIN) };
  window.railFixture = {
    failNextWrite: () => {
      failNext = true;
    },
    setWriteDelay: (ms) => {
      writeDelay = ms;
    },
    order: () => describe(snapshot),
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

    if (method === 'GET' && path === '/workspace') return success(snapshot);

    const order = matchOrderRoute(method, path);
    if (!order) {
      return failure(404, 'api_route_not_found', `No fixture route for ${method} ${path}`);
    }

    if (writeDelay > 0) await delay(writeDelay);
    if (failNext) {
      failNext = false;
      // A real refusal envelope — the reason plus the source identifiers the
      // contract requires — so the web layer decodes it as a typed rejection and
      // runs its own classification and copy selection, rather than falling
      // through to a generic "could not read the response" failure.
      return failure(400, order.code, 'The fixture runtime refused this order.', {
        ...(order.output as Record<string, number>),
        reason: order.rejectionReason,
      });
    }

    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, number | null>;
    const beforeId = body[order.anchorField] ?? null;
    snapshot = order.apply(snapshot, beforeId);
    return success(order.output);
  };
}

interface OrderRoute {
  readonly code: string;
  /**
   * The reason a refused write reports. Every one of these keeps the failure
   * *inline* at the dragged row rather than routing it to a toast, because none
   * of them says the moved row or its list has gone away. The worktree and
   * surface scopes use a mismatch — a trust-boundary reason, which is also the
   * case that takes the generic summary rather than a line about something
   * having disappeared.
   */
  readonly rejectionReason: string;
  readonly anchorField: string;
  readonly output: unknown;
  readonly apply: (snapshot: WorkspaceSnapshot, beforeId: number | null) => WorkspaceSnapshot;
}

function matchOrderRoute(method: string, path: string): OrderRoute | null {
  if (method !== 'PUT') return null;

  const project = /^\/projects\/(\d+)\/order$/.exec(path);
  if (project) {
    const projectId = Number(project[1]);
    return {
      code: 'project_order_rejected',
      rejectionReason: 'before_project_not_found',
      anchorField: 'beforeProjectId',
      output: { projectId },
      apply: (snapshot, beforeId) => ({
        ...snapshot,
        projects: reorder(snapshot.projects, projectId, beforeId, (p) => p.status === 'present'),
      }),
    };
  }

  const worktree = /^\/projects\/(\d+)\/worktrees\/(\d+)\/order$/.exec(path);
  if (worktree) {
    const projectId = Number(worktree[1]);
    const worktreeId = Number(worktree[2]);
    return {
      code: 'worktree_order_rejected',
      rejectionReason: 'worktree_project_mismatch',
      anchorField: 'beforeWorktreeId',
      output: { projectId, worktreeId },
      apply: (snapshot, beforeId) => ({
        ...snapshot,
        projects: snapshot.projects.map((candidate) =>
          candidate.id === projectId
            ? {
                ...candidate,
                worktrees: reorder(candidate.worktrees, worktreeId, beforeId, (w) => !w.isRoot),
              }
            : candidate,
        ),
      }),
    };
  }

  const surface = /^\/worktrees\/(\d+)\/surfaces\/(\d+)\/order$/.exec(path);
  if (surface) {
    const worktreeId = Number(surface[1]);
    const surfaceId = Number(surface[2]);
    return {
      code: 'surface_order_rejected',
      rejectionReason: 'surface_worktree_mismatch',
      anchorField: 'beforeSurfaceId',
      output: { worktreeId, surfaceId },
      apply: (snapshot, beforeId) => ({
        ...snapshot,
        projects: snapshot.projects.map((owner) => ({
          ...owner,
          worktrees: owner.worktrees.map((candidate) =>
            candidate.id === worktreeId
              ? { ...candidate, surfaces: reorder(candidate.surfaces, surfaceId, beforeId) }
              : candidate,
          ),
        })),
      }),
    };
  }

  return null;
}

/**
 * Reorder the members that pass `reorderable` and splice the fixed ones back
 * where they belong — the head, for a project's root worktree, and the tail, for
 * the Disconnected section. The runtime keeps both groups apart for real
 * reasons; a fixture that flattened them would let a drag produce an order the
 * runtime could never return.
 */
function reorder<Item extends { readonly id: number }>(
  items: readonly Item[],
  movedId: number,
  beforeId: number | null,
  reorderable: (item: Item) => boolean = () => true,
): Item[] {
  const fixed = items.filter((item) => !reorderable(item));
  const rest = items.filter(reorderable);
  const ids = moveBefore(
    rest.map((item) => item.id),
    movedId,
    beforeId,
  );
  const byId = new Map(rest.map((item) => [item.id, item]));
  const ordered = ids.flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
  // Roots lead their worktree list; disconnected projects trail the present
  // ones. Both are decided by the *first* fixed member's position in the input.
  const rootFirst = items.length > 0 && !reorderable(items[0]!);
  return rootFirst ? [...fixed, ...ordered] : [...ordered, ...fixed];
}

function describe(snapshot: WorkspaceSnapshot): string {
  return snapshot.projects
    .map(
      (project) =>
        `${project.name}\n` +
        project.worktrees
          .map(
            (worktree) =>
              `  ${worktree.title}` +
              (worktree.surfaces.length > 0
                ? `\n    [${worktree.surfaces.map((surface) => surface.title).join(', ')}]`
                : ''),
          )
          .join('\n'),
    )
    .join('\n\n');
}

function success(data: unknown) {
  return json(200, { data, meta: { requestId: 'rail-fixture' } });
}

function failure(status: number, code: string, message: string, data?: unknown) {
  return json(status, {
    error: { code, status, message, requestId: 'rail-fixture', ...(data ? { data } : {}) },
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
