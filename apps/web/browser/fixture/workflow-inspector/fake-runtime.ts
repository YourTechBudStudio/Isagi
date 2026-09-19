import type { WorkspaceSnapshot, SurfaceDetail, ControlPlaneSnapshot } from '@isagi/contracts';

import { evidenceBytes, evidenceRecords, listEvidence } from './evidence.js';
import {
  buildWorld,
  PIN_ONE,
  PIN_TWO,
  RUN_ID,
  type FixtureWorld,
  type ScenarioKey,
} from './world.js';

/**
 * The runtime boundary the inspector page talks to.
 *
 * A `fetch` stand-in rather than stubbed hooks, for the same reason the workflow-bar page uses one:
 * the coordinator's paging, contiguity and recovery rules are the machinery under test, and stubbing
 * the client would test everything except them.
 *
 * Pages are deliberately small. A real route caps its own limit regardless of what a client asks
 * for, and a fixture that always answered in one page would let "more than one page" go untested
 * forever.
 */

export const RUNTIME_ORIGIN = 'http://workflow-inspector.fixture';
export const FIXTURE_PLACEMENT = { projectId: 1, worktreeId: 12, surfaceId: 121, paneId: 1211 };

const EXECUTIONS_PER_PAGE = 25;
const OPERATIONS_PER_PAGE = 3;

export interface InspectorRuntimeControls {
  readonly setScenario: (scenario: ScenarioKey) => void;
  readonly adoptSecondPin: () => void;
  readonly setLongHistory: (long: boolean) => void;
  readonly setManyOperations: (many: boolean) => void;
  /** The next operations read fails, once, so the dock's honest incompleteness is observable. */
  readonly failNextOperationsRead: () => void;
  readonly world: () => FixtureWorld;
  readonly requestPaths: () => readonly string[];
  readonly resetRequests: () => void;
}

export function installFakeRuntime(): InspectorRuntimeControls {
  let scenario: ScenarioKey = 'waiting_questions';
  let pin = PIN_ONE;
  let longHistory = false;
  let manyOperations = false;
  let failOperations = false;
  let requestPaths: string[] = [];
  let nextRequestId = 1;

  let world = buildWorld({ scenario, pin, longHistory, manyOperations });
  const rebuild = () => {
    world = buildWorld({ scenario, pin, longHistory, manyOperations });
  };

  window.isagi = { getRuntimeUrl: () => Promise.resolve(RUNTIME_ORIGIN) };

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const method = init?.method ?? 'GET';
    requestPaths.push(`${method} ${path}${url.search}`);

    if (method === 'GET' && path === '/workspace') return success(workspace);
    if (method === 'GET' && path === '/control-plane') return success(controlPlane);
    if (method === 'GET' && /^\/surfaces\/\d+$/.test(path)) return success(surfaceDetail);
    if (method === 'GET' && /^\/worktrees\/\d+\/commands$/.test(path)) {
      return success({ worktreeId: 12, status: 'configured', commands: [], removedCommands: [] });
    }

    if (method === 'GET' && path === `/workflows/runs/${RUN_ID}`) {
      return success({ run: world.summary });
    }

    if (method === 'GET' && path === `/workflows/runs/${RUN_ID}/structure`) {
      // The whole contract shape, because the client decodes it. A fixture that answered with a
      // convenient subset would let a missing field pass here and fail in the product.
      return success({
        artifactHash: world.artifactHash,
        workflowKey: world.summary.workflowKey,
        sdkVersion: '0.1.0',
        verifierVersion: '0.1.0',
        pinOrdinal: world.summary.pinOrdinal,
        adoptedAt: world.summary.createdAt,
        descriptor: world.descriptor,
      });
    }

    if (method === 'GET' && path === `/workflows/runs/${RUN_ID}/executions`) {
      const offset = Number(url.searchParams.get('cursor') ?? 0);
      const items = world.executions.slice(offset, offset + EXECUTIONS_PER_PAGE);
      const nextOffset = offset + items.length;
      const complete = nextOffset >= world.executions.length;
      return success({
        items,
        nextCursor: complete ? null : String(nextOffset),
        boundary: {
          highWaterRevision: world.summary.revision,
          // Only the last page may acknowledge coverage: a client that acknowledged a revision it
          // was never given would skip the real deltas forever.
          coverageRevision: complete ? world.summary.revision : 0,
          snapshotToken: `fixture-${world.summary.revision}`,
          complete,
        },
        changes: {
          frames: offset === 0 ? world.frames : [],
          // Deliberately empty, exactly as the real hydration route answers: an execution carries
          // its own operation summary, and the cards are read for the one visit somebody selected.
          operations: [],
          ...(offset === 0 ? { summary: world.summary } : {}),
        },
      });
    }

    if (method === 'GET' && path === `/workflows/runs/${RUN_ID}/events`) {
      return success({
        items: world.events,
        nextCursor: null,
        boundary: {
          highWaterRevision: world.summary.revision,
          coverageRevision: world.summary.revision,
          snapshotToken: `fixture-${world.summary.revision}`,
          complete: true,
        },
      });
    }

    if (method === 'GET' && path === `/workflows/runs/${RUN_ID}/operations`) {
      if (failOperations) {
        failOperations = false;
        return failure(500, 'workflow_run_not_found');
      }
      const executionId = Number(url.searchParams.get('executionId') ?? 0);
      const all = world.operations.filter((row) => row.executionId === executionId);
      const offset = Number(url.searchParams.get('cursor') ?? 0);
      const items = all.slice(offset, offset + OPERATIONS_PER_PAGE);
      const nextOffset = offset + items.length;
      return success({
        items,
        nextCursor: nextOffset >= all.length ? null : String(nextOffset),
      });
    }

    const payload = /^\/workflows\/runs\/\d+\/payloads\/(.+)$/.exec(path);
    if (method === 'GET' && payload) {
      const ref = decodeURIComponent(payload[1]!);
      const record = world.payloads.get(ref);
      // 409 with the contract's own rejection shape. A status the contract does not allow would
      // decode-fail instead, and the page would be testing a transport error rather than an
      // unreadable payload.
      if (record === undefined || record === 'missing') return unreadable(ref, 'missing');
      if (record === 'corrupt') return unreadable(ref, 'corrupt');
      return success({ payloadRef: ref, ...record });
    }

    if (method === 'GET' && path === `/workflows/runs/${RUN_ID}/evidence`) {
      // Unpaged on purpose: the client pages every page into one array regardless, and the
      // scoping — visit, and visit-and-below — is the part a UI test can actually get wrong.
      return success({ ...listEvidence(url.searchParams), nextCursor: null });
    }

    const evidence = /^\/workflows\/runs\/\d+\/evidence\/([^/]+)$/.exec(path);
    if (method === 'GET' && evidence) {
      const key = decodeURIComponent(evidence[1]!);
      const found = evidenceRecords.find((item) => item.evidenceKey === key);
      if (found === undefined) return failure(404, 'workflow_evidence_not_found');
      return success({ evidence: found });
    }

    const content = /^\/workflows\/runs\/\d+\/evidence\/([^/]+)\/content$/.exec(path);
    if (method === 'GET' && content) {
      const key = decodeURIComponent(content[1]!);
      const record = evidenceRecords.find((item) => item.evidenceKey === key);
      const bytes = evidenceBytes.get(key);
      if (record === undefined || bytes === undefined) {
        return failure(404, 'workflow_evidence_not_found');
      }
      if (bytes.kind === 'unavailable') return contentUnavailable(key, bytes.cause);
      const body =
        bytes.kind === 'text'
          ? new Blob([bytes.text], { type: record.content.mediaType })
          : new Blob([Uint8Array.from(atob(bytes.base64), (c) => c.charCodeAt(0))], {
              type: record.content.mediaType,
            });
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { 'content-type': record.content.mediaType },
        }),
      );
    }

    const operation = /^\/workflows\/runs\/\d+\/operations\/([^/]+)$/.exec(path);
    if (method === 'GET' && operation) {
      const key = decodeURIComponent(operation[1]!);
      const found = world.operations.find((row) => row.operationKey === key);
      if (found === undefined) return failure(404, 'workflow_operation_not_found');
      // `getOperation` is the one read permitted to touch the filesystem, so it is also the only
      // one that answers the transcript question at all. The listing leaves it absent.
      return success({
        operation: {
          ...found,
          provenance: {
            ...found.provenance,
            transcript:
              found.capability === 'run_headless_agent'
                ? { locator: '~/.claude/projects/fixture/d02f91ee.jsonl', available: false }
                : null,
          },
        },
      });
    }

    const control = /^\/workflows\/runs\/\d+\/(pause|resume|retry|cancel|dismiss|advance)$/.exec(
      path,
    );
    if (method === 'POST' && control) {
      return success({
        runId: RUN_ID,
        accepted: true,
        status: world.summary.status,
        revision: world.summary.revision + 1,
        diagnostics: [],
      });
    }

    return failure(404, 'workflow_run_not_found');
  }) as typeof fetch;

  return {
    setScenario: (next) => {
      scenario = next;
      rebuild();
    },
    adoptSecondPin: () => {
      pin = pin === PIN_ONE ? PIN_TWO : PIN_ONE;
      rebuild();
    },
    setLongHistory: (long) => {
      longHistory = long;
      rebuild();
    },
    setManyOperations: (many) => {
      manyOperations = many;
      rebuild();
    },
    failNextOperationsRead: () => {
      failOperations = true;
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

  /** The runtime's own rejection for captured bytes the content store cannot serve. */
  function contentUnavailable(evidenceKey: string, cause: 'missing' | 'corrupt') {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          error: {
            code: 'workflow_rejected',
            status: 409,
            message: 'raw runtime diagnostic text that must not be voiced',
            requestId: `req-${nextRequestId++}`,
            data: {
              reason: 'workflow_evidence_content_unavailable',
              evidenceKey,
              cause,
              workflowRunId: RUN_ID,
            },
          },
          meta: { requestId: `req-${nextRequestId++}` },
        }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      ),
    );
  }

  /** The runtime's own rejection for a recorded value its store cannot serve. */
  function unreadable(payloadRef: string, cause: 'missing' | 'corrupt') {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          error: {
            code: 'workflow_rejected',
            status: 409,
            message: 'raw runtime diagnostic text that must not be voiced',
            requestId: `req-${nextRequestId++}`,
            data: {
              reason: 'workflow_payload_unavailable',
              payloadRef,
              cause,
              workflowRunId: RUN_ID,
            },
          },
          meta: { requestId: `req-${nextRequestId++}` },
        }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      ),
    );
  }

  function failure(status: number, reason: string, cause?: string) {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          error: {
            code: 'workflow_rejected',
            status,
            message: 'raw runtime diagnostic text that must not be voiced',
            requestId: `req-${nextRequestId++}`,
            data: { reason, workflowRunId: RUN_ID, ...(cause === undefined ? {} : { cause }) },
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
