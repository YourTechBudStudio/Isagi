import type {
  ControlPlaneSnapshot,
  SurfaceDetail,
  WorkflowEventDto,
  WorkspaceSnapshot,
} from '@isagi/contracts';

import { answerCheckpointRoute, CHECKPOINT_PIN } from './checkpoints.js';
import {
  at,
  buildWorld,
  descriptorFor,
  PIN_ONE,
  PIN_TWO,
  type FixtureWorld,
  type ScenarioKey,
} from './world.js';

/**
 * The runtime boundary the inspector page talks to.
 *
 * A `fetch` stand-in rather than stubbed hooks, for the same reason the workflow-bar page uses one:
 * the event paging, the refetch on a pushed event and the per-execution reads are the machinery
 * under test, and stubbing the client would test everything except them.
 *
 * The event route answers in small pages. A real route may cap its own limit below what a client
 * asks for, and a fixture that always answered in one page would let "more than one page" go
 * untested forever.
 */

export const RUNTIME_ORIGIN = 'http://workflow-inspector.fixture';
export const FIXTURE_PLACEMENT = { projectId: 1, worktreeId: 12, surfaceId: 121, paneId: 1211 };

const EVENTS_PER_PAGE = 20;
/** The first run's id. Every scenario switch is a new run on the same surface, with the next id. */
export const FIRST_RUN_ID = 77;

export interface InspectorRuntimeControls {
  /** A new run with this scenario takes the surface. Returns the run it replaced. */
  readonly setScenario: (scenario: ScenarioKey) => void;
  /** A new run of the current scenario with a long history takes the surface. */
  readonly setLongHistory: (long: boolean) => void;
  /**
   * A Retry moved the run onto the next build. Returns the event the runtime would have appended,
   * so the page can push it exactly as the runtime does.
   */
  readonly reloadNextBuild: () => WorkflowEventDto;
  /** The agent turn `read` waits on has ended; its reply is recorded. Returns the pushed event. */
  readonly arriveReply: () => WorkflowEventDto;
  /** The next execution detail read fails, once. */
  readonly failNextExecutionRead: () => void;
  readonly failNextEventsRead: () => void;
  readonly world: () => FixtureWorld;
  readonly requestPaths: () => readonly string[];
  readonly resetRequests: () => void;
}

export function installFakeRuntime(): InspectorRuntimeControls {
  let scenario: ScenarioKey = 'waiting_questions';
  let runId = FIRST_RUN_ID;
  let pin = PIN_ONE;
  let longHistory = false;
  let replyArrived = false;
  let extraEvents: Omit<WorkflowEventDto, 'eventId' | 'runId'>[] = [];
  let failExecution = false;
  let failEvents = false;
  let requestPaths: string[] = [];
  let nextRequestId = 1;

  const build = () => buildWorld({ runId, scenario, pin, longHistory, replyArrived, extraEvents });
  let world = build();
  const newRun = () => {
    runId += 1;
    pin = PIN_ONE;
    replyArrived = false;
    extraEvents = [];
    world = build();
  };
  const append = (event: Omit<WorkflowEventDto, 'eventId' | 'runId'>) => {
    extraEvents = [...extraEvents, event];
    world = build();
    return world.events.at(-1)!;
  };

  window.isagi = { getRuntimeUrl: () => Promise.resolve(RUNTIME_ORIGIN) };

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const method = init?.method ?? 'GET';
    requestPaths.push(`${method} ${path}${url.search}`);
    const runPath = `/workflows/runs/${world.runId}`;

    if (method === 'GET' && path === '/workspace') return success(workspace);
    if (method === 'GET' && path === '/control-plane') return success(controlPlane);
    if (method === 'GET' && /^\/surfaces\/\d+$/.test(path)) return success(surfaceDetail);
    if (method === 'GET' && /^\/worktrees\/\d+\/commands$/.test(path)) {
      return success({ worktreeId: 12, status: 'configured', commands: [], removedCommands: [] });
    }

    if (method === 'GET' && path === runPath) return success(world.detail);

    if (method === 'GET' && path === `${runPath}/structure`) {
      // The whole contract shape, because the client decodes it. A fixture that answered with a
      // convenient subset would let a missing field pass here and fail in the product.
      const artifactHash = url.searchParams.get('artifactHash') ?? world.summary.artifactHash;
      return success({
        artifactHash,
        workflowKey: world.summary.workflowKey,
        sdkVersion: '0.1.0',
        verifierVersion: '0.1.0',
        contractVersion: 5,
        firstSeenAt: at(0),
        descriptor: descriptorFor(artifactHash),
      });
    }

    if (method === 'GET' && path === `${runPath}/events`) {
      if (failEvents) {
        failEvents = false;
        return failure(500, 'workflow_run_not_found');
      }
      const cursor = Number(url.searchParams.get('cursor') ?? 0);
      const after = world.events.filter((event) => event.eventId > cursor);
      const page = after.slice(0, EVENTS_PER_PAGE);
      return success({
        items: page,
        nextCursor: after.length > page.length ? page.at(-1)!.eventId : null,
      });
    }

    const execution = /^\/workflows\/executions\/(\d+)$/.exec(path);
    if (method === 'GET' && execution) {
      if (failExecution) {
        failExecution = false;
        return failure(500, 'workflow_execution_not_found');
      }
      const found = world.executionDetails.get(Number(execution[1]));
      if (found === undefined) return failure(404, 'workflow_execution_not_found');
      return success({ execution: found });
    }

    const checkpoint =
      method === 'GET'
        ? answerCheckpointRoute(
            world.runId,
            path,
            url.searchParams,
            world.summary.artifactHash === CHECKPOINT_PIN,
          )
        : null;
    if (checkpoint !== null) {
      switch (checkpoint.kind) {
        case 'json':
          return success(checkpoint.data);
        case 'not_found':
          return failure(404, checkpoint.reason);
        case 'network_error':
          // No response at all: the client must not read this as lost bytes.
          return Promise.reject(new TypeError('Failed to fetch'));
        case 'content_unavailable':
          return failure(409, 'workflow_checkpoint_content_unavailable', {
            checkpointId: checkpoint.checkpointId,
            path: checkpoint.path,
          });
        case 'bytes':
          return Promise.resolve(
            new Response(checkpoint.body, {
              status: 200,
              headers: { 'content-type': 'application/octet-stream' },
            }),
          );
      }
    }

    const control = /^\/workflows\/runs\/\d+\/(pause|resume|retry|cancel|dismiss|advance)$/.exec(
      path,
    );
    if (method === 'POST' && control) return success({ run: world.summary });

    return failure(404, 'workflow_run_not_found');
  }) as typeof fetch;

  return {
    setScenario: (next) => {
      scenario = next;
      newRun();
    },
    setLongHistory: (long) => {
      longHistory = long;
      newRun();
    },
    reloadNextBuild: () => {
      const from = pin;
      pin = pin === PIN_TWO ? PIN_ONE : PIN_TWO;
      return append({
        executionId: null,
        at: new Date().toISOString(),
        category: 'run',
        kind: 'code_reloaded',
        message: 'Reloaded the latest build',
        data: { from, to: pin },
      });
    },
    arriveReply: () => {
      replyArrived = true;
      return append({
        executionId: 104,
        at: new Date().toISOString(),
        category: 'log',
        kind: 'log',
        message: 'Recorded the agent reply',
        data: { level: 'info', message: 'Recorded the agent reply' },
      });
    },
    failNextExecutionRead: () => {
      failExecution = true;
    },
    failNextEventsRead: () => {
      failEvents = true;
    },
    world: () => world,
    requestPaths: () => requestPaths,
    resetRequests: () => {
      requestPaths = [];
    },
  };

  function success(data: unknown) {
    return Promise.resolve(
      new Response(JSON.stringify({ data, meta: { requestId: `req-${nextRequestId++}` } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }

  function failure(status: number, reason: string, extra: Record<string, unknown> = {}) {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          error: {
            code: 'workflow_rejected',
            status,
            message: 'raw runtime diagnostic text that must not be voiced',
            requestId: `req-${nextRequestId++}`,
            data: { reason, workflowRunId: world.runId, ...extra },
          },
          meta: { requestId: `req-${nextRequestId++}` },
        }),
        { status, headers: { 'content-type': 'application/json' } },
      ),
    );
  }
}

const workspace: WorkspaceSnapshot = {
  projects: [
    {
      id: FIXTURE_PLACEMENT.projectId,
      name: 'isagi',
      rootPath: '/work/isagi',
      kind: 'git',
      status: 'present',
      worktrees: [
        {
          id: FIXTURE_PLACEMENT.worktreeId,
          projectId: FIXTURE_PLACEMENT.projectId,
          title: 'release',
          path: '/work/isagi/.worktrees/release',
          branch: 'feat/release-check',
          head: 'abcdef0',
          isRoot: false,
          parked: false,
          surfaces: [
            { id: FIXTURE_PLACEMENT.surfaceId, title: 'Pi', paneKinds: ['agent_session'] },
          ],
          activeSurfaceId: FIXTURE_PLACEMENT.surfaceId,
        },
      ],
    },
  ],
};

const surfaceDetail: SurfaceDetail = {
  id: FIXTURE_PLACEMENT.surfaceId,
  worktreeId: FIXTURE_PLACEMENT.worktreeId,
  title: 'Pi',
  layout: {
    kind: 'leaf',
    nodeId: `leaf-${FIXTURE_PLACEMENT.paneId}`,
    paneId: FIXTURE_PLACEMENT.paneId,
    collapsed: false,
  },
  activePaneId: FIXTURE_PLACEMENT.paneId,
  panes: [],
};

const controlPlane: ControlPlaneSnapshot = {
  onboardingComplete: true,
  configStatus: 'valid',
  configDiagnostic: null,
  policyRevision: 'fixture-policy',
  inventory: { status: 'ready', generation: 1, environment: 'trusted' },
  harnesses: [],
  reconciliation: {
    desiredFingerprint: null,
    runningFingerprint: null,
    lastCompletedFingerprint: null,
    lastAppliedFingerprint: null,
    lastResult: null,
  },
  editorProvisioning: { status: 'not_applicable' },
};
