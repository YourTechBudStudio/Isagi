import type {
  ControlPlaneSnapshot,
  EditorContextMetadata,
  SurfaceDetail,
  WorkspaceSnapshot,
} from '@isagi/contracts';

/**
 * A runtime made of one mutable projection and a `fetch` stub, in the shape the
 * command-palette fixture already established.
 *
 * The page mounts the production `Surface`, so the real query observer, the real
 * runtime client and its decoding, the real `EditorPaneContainer`, and the real
 * invalidation all execute. Only the process at the other end of the wire is
 * replaced.
 *
 * It applies ensures for real: an `ensureRuntime` mutates the surface detail this
 * object serves, so the refetch that follows *converges* on the transition. A
 * fixture that only recorded the request would prove the client spoke and nothing
 * about whether the pane then tells the truth.
 */
export interface EditorRuntimeControls {
  /** Ordered ensure requests — the record a mount-time `reuse` has to appear in. */
  readonly ensureRequests: () => readonly {
    readonly editorContextId: number;
    readonly intent: string;
  }[];
  /** Ordered diagnostics reads, so incarnation keying is observable. */
  readonly diagnosticsRequests: () => readonly {
    readonly editorContextId: number;
    readonly ptyProcessId: number;
  }[];
  /** Replace the projected editor facts and let the next surface read converge. */
  readonly setEditor: (patch: Partial<EditorContextMetadata>) => void;
  /** Hold every ensure open for `ms`, widening the in-flight window. */
  readonly setEnsureDelay: (ms: number) => void;
  /**
   * Refuse the next ensure. `launch` produces `editor_launch_failed`, which the
   * runtime has already recorded on the context; anything else is a transient
   * client-side fact with no home in the projection.
   */
  readonly failNextEnsure: (kind: 'launch' | 'database') => void;
  /** Refuse the next diagnostics read. */
  readonly failNextDiagnostics: () => void;
  /** What the ensure applies to the projection when it succeeds. */
  readonly setEnsureResult: (patch: Partial<EditorContextMetadata>) => void;
}

const RUNTIME_ORIGIN = 'http://editor-test-support.invalid';

export const WORKTREE_ID = 12;
export const SURFACE_ID = 42;
export const PANE_ID = 77;
/**
 * A second, ordinary pane. Not decoration: with one pane, `SurfaceLayout`'s sync
 * effect resolves the only pane as active and *re-sets* it the moment anything
 * clears it, so pane activation is not observable at all. Two panes make it the
 * genuine choice it is in the product, and this is a real state — an editor
 * surface a user has split.
 *
 * It is an empty pane, so `PtyPane` renders its own idle view and claims
 * nothing — no PTY transport is needed to stand a second pane up.
 */
export const NEIGHBOUR_PANE_ID = 78;
export const EDITOR_CONTEXT_ID = 7;
/** Served by the fixture's own dev server, so the frame is a real cross-document load. */
export const WORKBENCH_URL = '/test-support/editor/workbench.html';

export const IDLE_EDITOR: EditorContextMetadata = {
  paneId: PANE_ID,
  id: EDITOR_CONTEXT_ID,
  worktreeId: WORKTREE_ID,
  activePtyProcessId: null,
  attempt: { state: 'none' },
  processStatus: null,
  processDiagnostic: null,
  processDiagnosticDetail: null,
  workbenchReadiness: null,
  readinessDetail: null,
  endpoint: null,
  hasDiagnostics: false,
  createdAt: '2026-08-31T09:00:00.000Z',
  updatedAt: '2026-08-31T09:00:00.000Z',
};

export const READY_EDITOR: Partial<EditorContextMetadata> = {
  activePtyProcessId: 48120,
  processStatus: 'running',
  workbenchReadiness: 'ready',
  endpoint: { host: '127.0.0.1', port: 41287, url: WORKBENCH_URL },
};

/** An incarnation that started, produced output, and died. */
export const SETTLED_EDITOR: Partial<EditorContextMetadata> = {
  activePtyProcessId: 48120,
  processStatus: 'exited',
  processDiagnostic: 'exited',
  processDiagnosticDetail: 'exit code 1',
  hasDiagnostics: true,
};

/**
 * Pre-mount state comes from the URL, not from a control call.
 *
 * The mount-time `reuse` fires before any test can reach `window`, so anything
 * that has to be true *for that first request* has to be in place when the page
 * loads. The controls remain for everything that changes mid-test.
 */
function seeds(): {
  readonly failFirstEnsure: 'launch' | 'database' | null;
  readonly ensureDelay: number;
  readonly settled: boolean;
  readonly ready: boolean;
  readonly failFirstDiagnostics: boolean;
} {
  const params = new URLSearchParams(window.location.search);
  const fail = params.get('failFirstEnsure');
  return {
    failFirstEnsure: fail === 'launch' || fail === 'database' ? fail : null,
    ensureDelay: Number(params.get('ensureDelay') ?? '0') || 0,
    settled: params.get('settled') === '1',
    ready: params.get('ready') === '1',
    failFirstDiagnostics: params.get('failFirstDiagnostics') === '1',
  };
}

export function installFakeRuntime(): EditorRuntimeControls {
  const seed = seeds();
  // `ready=1` opens on an editor that is *already* serving, which is what a pane
  // mounting against a running workbench actually sees.
  let editor: EditorContextMetadata = seed.ready
    ? { ...IDLE_EDITOR, ...READY_EDITOR }
    : IDLE_EDITOR;
  let ensureResult: Partial<EditorContextMetadata> = seed.settled ? SETTLED_EDITOR : READY_EDITOR;
  let ensureDelay = seed.ensureDelay;
  let failEnsure: 'launch' | 'database' | null = seed.failFirstEnsure;
  let failDiagnostics = seed.failFirstDiagnostics;
  const ensureRequests: { editorContextId: number; intent: string }[] = [];
  const diagnosticsRequests: { editorContextId: number; ptyProcessId: number }[] = [];

  window.isagi = { getRuntimeUrl: () => Promise.resolve(RUNTIME_ORIGIN) };

  const controls: EditorRuntimeControls = {
    ensureRequests: () => [...ensureRequests],
    diagnosticsRequests: () => [...diagnosticsRequests],
    setEditor: (patch) => {
      editor = { ...editor, ...patch };
    },
    setEnsureDelay: (ms) => {
      ensureDelay = ms;
    },
    failNextEnsure: (kind) => {
      failEnsure = kind;
    },
    failNextDiagnostics: () => {
      failDiagnostics = true;
    },
    setEnsureResult: (patch) => {
      ensureResult = patch;
    },
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

    if (method === 'GET' && path === '/workspace') return success(workspaceSnapshot());
    if (method === 'GET' && path === '/control-plane') return success(controlPlane());
    // Read by the empty neighbour pane's restore prompt. Empty is the honest
    // answer: this harness stands up no durable PTY sessions.
    if (method === 'GET' && path === '/workspace/durable-sessions') {
      return success({ agentSessions: [], terminalSessions: [] });
    }

    const surface = /^\/surfaces\/(\d+)$/.exec(path);
    if (method === 'GET' && surface) {
      return Number(surface[1]) === SURFACE_ID
        ? success(surfaceDetail(editor))
        : failure(404, 'runtime_database_failed', 'No such surface.', {
            operation: 'surfaces.get',
          });
    }

    const ensure = /^\/editor-contexts\/(\d+)\/runtime$/.exec(path);
    if (method === 'POST' && ensure) {
      const editorContextId = Number(ensure[1]);
      const body = JSON.parse(String(init?.body ?? '{}')) as { intent?: string };
      ensureRequests.push({ editorContextId, intent: body.intent ?? '' });

      if (ensureDelay > 0) await delay(ensureDelay);

      const refusal = failEnsure;
      failEnsure = null;
      if (refusal === 'launch') {
        // Already recorded on the context, so the projection carries it too. The
        // pane must render it once, from the projection, not twice.
        editor = {
          ...editor,
          attempt: { state: 'failed', reason: 'port_allocation_failed', detail: 'no free port' },
          activePtyProcessId: null,
        };
        return failure(409, 'editor_launch_failed', 'The editor did not start.', {
          reason: 'port_allocation_failed',
          editorContextId,
          detail: 'no free port',
        });
      }
      if (refusal === 'database') {
        return failure(500, 'runtime_database_failed', 'The fixture runtime cannot write.', {
          operation: 'editorContexts.ensureRuntime',
        });
      }

      editor = { ...editor, ...ensureResult };
      const { paneId: _paneId, ...facts } = editor;
      return success({ editorContext: facts });
    }

    const diagnostics = /^\/editor-contexts\/(\d+)\/diagnostics$/.exec(path);
    if (method === 'GET' && diagnostics) {
      const editorContextId = Number(diagnostics[1]);
      const ptyProcessId = Number(url.searchParams.get('ptyProcessId'));
      diagnosticsRequests.push({ editorContextId, ptyProcessId });
      if (failDiagnostics) {
        failDiagnostics = false;
        return failure(500, 'editor_diagnostics_unavailable', 'The log could not be read.', {
          detail: 'EACCES',
        });
      }
      return success({
        editorContextId,
        ptyProcessId,
        excerpt: `code-server startup output for pid ${ptyProcessId}\nEADDRINUSE 127.0.0.1:41287`,
        truncated: true,
        totalBytes: 20_480,
      });
    }

    // Loudly, not with a permissive catch-all: an unknown route means production
    // started depending on something this page has never stood up.
    console.error('[editor test support] no route for', method, path);
    return failure(404, 'api_route_not_found', `No fixture route for ${method} ${path}`);
  };

  return controls;
}

function surfaceDetail(editor: EditorContextMetadata): SurfaceDetail {
  return {
    id: SURFACE_ID,
    worktreeId: WORKTREE_ID,
    title: 'Editor',
    layout: {
      kind: 'split',
      nodeId: 'root',
      axis: 'row',
      sizing: 'auto',
      weights: [0.7, 0.3],
      children: [
        { kind: 'leaf', nodeId: 'n1', paneId: PANE_ID, collapsed: false },
        { kind: 'leaf', nodeId: 'n2', paneId: NEIGHBOUR_PANE_ID, collapsed: false },
      ],
    },
    // The neighbour starts active, so entering the workbench is a real move.
    activePaneId: NEIGHBOUR_PANE_ID,
    panes: [
      {
        id: PANE_ID,
        surfaceId: SURFACE_ID,
        title: 'isagi · feat/embedded-editor',
        sortOrder: 0,
        session: { kind: 'editor_context', editorContext: editor },
      },
      {
        id: NEIGHBOUR_PANE_ID,
        surfaceId: SURFACE_ID,
        title: 'shell',
        sortOrder: 1,
        // An empty pane: a real state, and one that claims nothing, so the
        // harness needs no PTY transport to stand a second pane up.
        session: null,
      },
    ],
  };
}

function workspaceSnapshot(): WorkspaceSnapshot {
  return {
    projects: [
      {
        id: 1,
        name: 'isagi',
        rootPath: '/work/isagi',
        status: 'present',
        worktrees: [
          {
            id: WORKTREE_ID,
            projectId: 1,
            title: 'feat/embedded-editor',
            path: '/work/isagi-editor',
            branch: 'feat/embedded-editor',
            head: 'abcdef0',
            isRoot: false,
            parked: false,
            activeSurfaceId: SURFACE_ID,
            surfaces: [{ id: SURFACE_ID, title: 'Editor', paneKinds: ['editor_context'] }],
          },
        ],
      },
    ],
  };
}

function controlPlane(): ControlPlaneSnapshot {
  return {
    onboardingComplete: true,
    configStatus: 'valid',
    configDiagnostic: null,
    policyRevision: 'rev-1',
    inventory: { status: 'ready', generation: 1, environment: 'trusted' },
    harnesses: [],
    reconciliation: {
      desiredFingerprint: null,
      runningFingerprint: null,
      lastCompletedFingerprint: null,
      lastAppliedFingerprint: null,
      lastResult: null,
    },
    editorProvisioning: { status: 'ready', version: '4.135.0' },
  };
}

function success(data: unknown): Response {
  return new Response(JSON.stringify({ data, meta: { requestId: 'req-editor-fixture' } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function failure(
  status: number,
  code: string,
  message: string,
  data?: Record<string, unknown>,
): Response {
  return new Response(
    JSON.stringify({
      error: {
        code,
        status,
        message,
        requestId: 'req-editor-fixture',
        ...(data ? { data } : {}),
      },
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
