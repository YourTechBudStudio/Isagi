import type {
  ControlPlaneSnapshot,
  SurfaceDetail,
  WorkflowEventDto,
  WorkflowRunControlOutput,
  WorkflowRunSummary,
  WorktreeCommandsOutput,
  WorkspaceSnapshot,
} from '@isagi/contracts';

import {
  workflowEventFixture,
  workflowSummaryFixture,
} from '../../../src/lib/workspace/workflow/test-support.js';

/**
 * The runtime boundary the workflow-bar page talks to.
 *
 * Deliberately a `fetch` stand-in rather than stubbed hooks: the point of this page is the wiring
 * between the container, its mutations and the caches they read, and stubbing the client would test
 * everything except that. Requests are recorded so a spec can assert *which* route a control hit and
 * with what body — an advance that forgot its execution is a real bug that renders identically.
 *
 * All names, paths and branches are invented. Nothing here is real workspace data.
 */

export const RUNTIME_ORIGIN = 'http://workflow-bar.fixture';
export const FIXTURE_PLACEMENT = {
  projectId: 1,
  worktreeId: 12,
  surfaceId: 121,
  paneId: 1211,
} as const;

/** The one workflow the palette can offer, so "offered" and "withheld" are both observable. */
export const FIXTURE_WORKFLOW_KEY = 'fixture/release';

/**
 * The event route's page size. Smaller than the client's request, as a real route may be, so a
 * long log has to be followed across pages to be read at all.
 */
export const EVENT_PAGE_SIZE = 250;

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

export interface WorkflowBarRuntimeControls {
  /** A stable snapshot: the same reference until another request is recorded. */
  readonly requests: () => readonly RecordedRequest[];
  /** Notifies on every recorded request, so the page can publish them without polling. */
  readonly subscribe: (listener: () => void) => () => void;
  /** The next control POST is refused with this reason, once. */
  readonly rejectNextControl: (reason: string) => void;
  /** How many log events the run's event log holds. */
  readonly setLogLines: (count: number) => void;
  /** A log event appended to the run's log, so a later read and a live push agree on it. */
  readonly appendLogLine: () => WorkflowEventDto;
  /** The next event read fails, once. */
  readonly failNextLogRead: () => void;
  /** Holds the next control response open, so a spec can act while one is genuinely in flight. */
  readonly holdNextControl: () => void;
  readonly releaseHeldControl: () => void;
}

const snapshot: WorkspaceSnapshot = {
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
          title: 'a workflow on a surface',
          path: '/work/isagi/.worktrees/workflow',
          branch: 'feat/workflow',
          head: 'abcdef0',
          isRoot: false,
          parked: false,
          surfaces: [
            {
              id: FIXTURE_PLACEMENT.surfaceId,
              title: 'Pi',
              paneKinds: ['agent_session'],
            },
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
  // Deliberately no panes. This page is about which readers see the attached run; the launch context
  // the palette needs comes from the surface and its active pane id, both of which are still here.
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

const commands: WorktreeCommandsOutput = {
  worktreeId: FIXTURE_PLACEMENT.worktreeId,
  status: 'configured',
  commands: [],
  removedCommands: [],
};

export function installFakeRuntime(): WorkflowBarRuntimeControls {
  const requests: RecordedRequest[] = [];
  // A stable snapshot, replaced only when something is actually recorded. `useSyncExternalStore`
  // requires a cached value; returning a fresh copy on every read is an infinite render loop.
  let snapshotOfRequests: readonly RecordedRequest[] = requests.slice();
  const listeners = new Set<() => void>();
  let rejectReason: string | null = null;
  let logLines = 0;
  let failLogRead = false;
  let holdControl = false;
  let releaseControl: (() => void) | null = null;
  let nextRequestId = 1;

  window.isagi = { getRuntimeUrl: () => Promise.resolve(RUNTIME_ORIGIN) };

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const method = init?.method ?? 'GET';
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    requests.push({ method, path: `${path}${url.search}`, body });
    snapshotOfRequests = requests.slice();
    for (const listener of [...listeners]) listener();

    if (method === 'GET' && path === '/workspace') return success(snapshot);
    if (method === 'GET' && path === '/control-plane') return success(controlPlane);
    if (method === 'GET' && /^\/surfaces\/\d+$/.test(path)) return success(surfaceDetail);
    if (method === 'GET' && /^\/worktrees\/\d+\/commands$/.test(path)) return success(commands);
    if (method === 'POST' && path === '/workflows/descriptors') {
      return success({
        workflows: [
          {
            ok: true,
            workflowKey: FIXTURE_WORKFLOW_KEY,
            manifest: { title: 'Release', description: 'Runs the release checklist.' },
          },
        ],
      });
    }

    const control = /^\/workflows\/runs\/(\d+)\/(pause|resume|retry|cancel|dismiss|advance)$/.exec(
      path,
    );
    if (method === 'POST' && control) {
      const runId = Number(control[1]);
      const respond = () => {
        if (rejectReason !== null) {
          const reason = rejectReason;
          rejectReason = null;
          return failure(409, reason, runId, { control: control[2] });
        }
        // The run as it stands after the control. The bar writes nothing from it: the runtime pushes
        // what actually happened.
        return success({
          run: fixtureSummary('waiting_input', { runId }),
        } satisfies WorkflowRunControlOutput);
      };
      if (!holdControl) return respond();
      holdControl = false;
      // Held open so a spec can act while a control is genuinely in flight, which is the only way
      // to observe overlap and a reply that crosses a run swap.
      return new Promise<Response>((resolve) => {
        releaseControl = () => {
          releaseControl = null;
          void respond().then(resolve);
        };
      });
    }

    const events = /^\/workflows\/runs\/(\d+)\/events$/.exec(path);
    if (method === 'GET' && events) {
      if (failLogRead) {
        failLogRead = false;
        return failure(500, 'workflow_run_not_found', Number(events[1]));
      }
      const runId = Number(events[1]);
      const cursor = Number(url.searchParams.get('cursor') ?? 0);
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), EVENT_PAGE_SIZE);
      const items = logEvents(runId, logLines).filter((event) => event.eventId > cursor);
      const page = items.slice(0, limit);
      return success({
        items: page,
        nextCursor: items.length > limit ? page.at(-1)!.eventId : null,
      });
    }

    return failure(404, 'workflow_run_not_found', 0);
  }) as typeof fetch;

  return {
    requests: () => snapshotOfRequests,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    rejectNextControl: (reason) => {
      rejectReason = reason;
    },
    setLogLines: (count) => {
      logLines = count;
    },
    appendLogLine: () => {
      logLines += 1;
      return logEvent(77, logLines);
    },
    failNextLogRead: () => {
      failLogRead = true;
    },
    holdNextControl: () => {
      holdControl = true;
    },
    releaseHeldControl: () => {
      releaseControl?.();
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

  function failure(
    status: number,
    reason: string,
    workflowRunId: number,
    extra: Record<string, unknown> = {},
  ) {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          error: {
            code: 'workflow_rejected',
            status,
            // Diagnostic-only, exactly as the runtime sends it. A spec asserts this never reaches
            // the screen: the bar's line is Isagi's own.
            message: 'raw runtime diagnostic text that must not be voiced',
            requestId: `req-${nextRequestId++}`,
            data: { reason, ...(workflowRunId > 0 ? { workflowRunId } : {}), ...extra },
          },
          meta: { requestId: `req-${nextRequestId++}` },
        }),
        { status, headers: { 'content-type': 'application/json' } },
      ),
    );
  }
}

function logEvents(runId: number, count: number): readonly WorkflowEventDto[] {
  return Array.from({ length: count }, (_, index) => logEvent(runId, index + 1));
}

export function logEvent(runId: number, eventId: number): WorkflowEventDto {
  return workflowEventFixture({
    eventId,
    runId,
    executionId: 1,
    category: 'log',
    kind: 'log',
    message: `recorded line ${eventId}`,
    data: { level: 'info', message: `recorded line ${eventId}` },
  });
}

/** The run the page starts attached to, and the shapes its scenarios publish. */
export function fixtureSummary(
  scenario: 'waiting_input' | 'paused_continue' | 'failed' | 'done',
  input: {
    readonly runId?: number;
    readonly executionId?: number;
    readonly attached?: boolean;
  } = {},
): WorkflowRunSummary {
  const runId = input.runId ?? 77;
  const executionId = input.executionId ?? 5;
  const base = workflowSummaryFixture({ runId });
  const common = {
    runId,
    worktreeId: FIXTURE_PLACEMENT.worktreeId,
    surfaceId: input.attached === false ? null : FIXTURE_PLACEMENT.surfaceId,
  } as const;
  const current = (wait: NonNullable<WorkflowRunSummary['current']>['wait']) => ({
    executionId,
    invocationId: 1,
    graphKey: 'release',
    nodeId: 'triage',
    nodeKind: 'operation' as const,
    label: null,
    wait,
  });

  switch (scenario) {
    case 'waiting_input':
      return workflowSummaryFixture({
        ...common,
        status: 'waiting',
        current: current({
          kind: 'user_input',
          questions: [{ kind: 'text', key: 'verdict', label: 'What should the writer change?' }],
        }),
      });
    case 'paused_continue':
      return workflowSummaryFixture({
        ...common,
        status: 'paused',
        current: current({ kind: 'user_continue', label: 'Ready to carry on?' }),
        controls: { ...base.controls, pause: false, resume: true },
      });
    case 'failed':
      return workflowSummaryFixture({
        ...common,
        status: 'failed',
        current: current(null),
        error: {
          stage: 'node_function',
          message: 'TypeError: cannot read property draft of undefined',
          graphKey: 'release',
          nodeId: 'triage',
        },
        controls: { ...base.controls, pause: false, cancel: false, retry: true, dismiss: true },
      });
    case 'done':
      return workflowSummaryFixture({
        ...common,
        status: 'completed',
        endedAt: '2026-09-15T10:05:00.000Z',
        controls: { ...base.controls, pause: false, cancel: false, dismiss: true },
      });
  }
}
