import type {
  ControlPlaneSnapshot,
  SurfaceDetail,
  WorkflowRunControlOutput,
  WorkflowRunSummary,
  WorktreeCommandsOutput,
  WorkspaceSnapshot,
} from '@isagi/contracts';

import { workflowSummaryFixture } from '../../../src/lib/workspace/workflow/test-support.js';

/**
 * The runtime boundary the workflow-bar page talks to.
 *
 * Deliberately a `fetch` stand-in rather than stubbed hooks: the point of this page is the wiring
 * between the container, its mutations and the caches they read, and stubbing the client would test
 * everything except that. Requests are recorded so a spec can assert *which* route a control hit and
 * with what body — an advance that forgot its wait id is a real bug that renders identically.
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
  readonly setLogLines: (count: number) => void;
  /** The next recent-activity read fails, once. */
  readonly failNextLogRead: () => void;
  /** The log carries one entry whose detail is too large to have travelled inline. */
  readonly setStoredLogDetail: (stored: boolean) => void;
  /** Holds the next control response open, so a spec can act while one is genuinely in flight. */
  readonly holdNextControl: () => void;
  readonly releaseHeldControl: () => void;
  /** The same, for the recent-activity read: a spec can close and reopen mid-request. */
  readonly holdNextLogRead: () => void;
  readonly releaseHeldLogRead: () => void;
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
  // Deliberately no panes. This page is about which readers see the attached run, and a pane would
  // drag terminal presentation in behind it — real machinery, but not the machinery under test, and
  // `browser/AGENTS.md` asks for the smallest faithful environment. The launch context the palette
  // needs comes from the surface and its active pane id, both of which are still here.
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
  let storedLogDetail = false;
  let holdControl = false;
  let releaseControl: (() => void) | null = null;
  let holdLogRead = false;
  let releaseLogRead: (() => void) | null = null;
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
      const respond = () => {
        if (rejectReason !== null) {
          const reason = rejectReason;
          rejectReason = null;
          return failure(409, reason, Number(control[1]));
        }
        return success({
          runId: Number(control[1]),
          accepted: true,
          status: 'running',
          revision: 4,
          diagnostics: [],
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

    if (method === 'GET' && /^\/workflows\/runs\/\d+\/payloads\//.test(path)) {
      return success({
        payloadRef: 'sha256:big',
        mediaType: 'application/json',
        byteSize: 20_000,
        value: { source: 'author_log', level: 'info', message: 'the whole recorded line' },
      });
    }

    if (method === 'GET' && /^\/workflows\/runs\/\d+\/events$/.test(path)) {
      if (failLogRead) {
        failLogRead = false;
        return failure(500, 'workflow_run_not_found', 77);
      }
      const sinceRevision = Number(url.searchParams.get('sinceRevision') ?? 0);
      const answer = () =>
        success({
          items: Array.from({ length: logLines }, (_, index) =>
            logDelta(sinceRevision + index + 1, storedLogDetail),
          ),
          nextCursor: null,
          boundary: {
            highWaterRevision: sinceRevision + logLines,
            coverageRevision: sinceRevision + logLines,
            snapshotToken: 'fixture-token',
            complete: true,
          },
        });
      if (!holdLogRead) return answer();
      holdLogRead = false;
      return new Promise<Response>((resolve) => {
        releaseLogRead = () => {
          releaseLogRead = null;
          void answer().then(resolve);
        };
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
    failNextLogRead: () => {
      failLogRead = true;
    },
    setStoredLogDetail: (stored) => {
      storedLogDetail = stored;
    },
    holdNextControl: () => {
      holdControl = true;
    },
    releaseHeldControl: () => {
      releaseControl?.();
    },
    holdNextLogRead: () => {
      holdLogRead = true;
    },
    releaseHeldLogRead: () => {
      releaseLogRead?.();
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

  function failure(status: number, reason: string, workflowRunId: number) {
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
            data: { reason, workflowRunId },
          },
          meta: { requestId: `req-${nextRequestId++}` },
        }),
        { status, headers: { 'content-type': 'application/json' } },
      ),
    );
  }
}

function logDelta(revision: number, stored = false) {
  return {
    runId: 77,
    revision,
    transition: {
      revision,
      recordedAt: '2026-09-15T10:00:00.000Z',
      kind: 'log' as const,
      frameId: 1,
      executionId: 1,
      attemptId: null,
      operationKey: null,
      waitId: null,
      artifactHash: null,
      detailRef: stored
        ? { payloadRef: 'sha256:big', byteSize: 20_000, mediaType: 'application/json' }
        : { inline: { source: 'author_log', level: 'info', message: `recorded line ${revision}` } },
      stateRef: null,
    },
    changes: { executions: [], frames: [], operations: [] },
  };
}

/** The run the page starts attached to, and the shapes its scenarios publish. */
export function fixtureSummary(
  scenario: 'waiting_input' | 'paused_continue' | 'failed' | 'done',
  input: { readonly runId?: number; readonly waitId?: number; readonly revision?: number } = {},
): WorkflowRunSummary {
  const runId = input.runId ?? 77;
  const waitId = input.waitId ?? 5;
  const base = workflowSummaryFixture({ runId });
  const attachment = {
    worktreeId: FIXTURE_PLACEMENT.worktreeId,
    surfaceId: FIXTURE_PLACEMENT.surfaceId,
  };
  const common = { runId, attachment, revision: input.revision ?? 1 } as const;

  switch (scenario) {
    case 'waiting_input':
      return workflowSummaryFixture({
        ...common,
        status: 'waiting',
        blockingWait: {
          waitId,
          kind: 'user_input',
          label: 'The writer needs direction.',
          frameId: 1,
          executionId: 2,
          questions: [{ kind: 'text', key: 'verdict', label: 'What should the writer change?' }],
          armedAt: '2026-09-15T10:00:00.000Z',
        },
        controls: { ...base.controls, advance: true },
      });
    case 'paused_continue':
      return workflowSummaryFixture({
        ...common,
        status: 'waiting',
        paused: true,
        blockingWait: {
          waitId,
          kind: 'user_continue',
          label: 'Ready to carry on?',
          frameId: 1,
          executionId: 2,
          questions: null,
          armedAt: '2026-09-15T10:00:00.000Z',
        },
        controls: { ...base.controls, pause: false, resume: true, advance: true },
      });
    case 'failed':
      return workflowSummaryFixture({
        ...common,
        status: 'failed',
        failure: {
          code: 'node_callback_failed',
          message: 'TypeError: cannot read property draft of undefined',
          segmentKind: 'node_callback',
          attemptId: 3,
          frameId: 1,
          executionId: 2,
        },
        controls: { ...base.controls, pause: false, cancel: false, retry: true, dismiss: true },
      });
    case 'done':
      return workflowSummaryFixture({
        ...common,
        status: 'done',
        endedAt: '2026-09-15T10:05:00.000Z',
        controls: { ...base.controls, pause: false, cancel: false, dismiss: true },
      });
  }
}
