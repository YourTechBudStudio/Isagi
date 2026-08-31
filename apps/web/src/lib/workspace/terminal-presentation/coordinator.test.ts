import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';

import { QueryClient } from '@tanstack/react-query';

import { terminalSettingsDefaults, type DurableSessionInventory } from '@isagi/contracts';

import { surfaceDetailQueryKey } from '../query-keys.js';
import { createTerminalPresentationCache } from '../terminal-cache/index.js';
import type { TerminalPresentationController } from './controller.js';
import { publishTerminalWorkspaceFact } from './coordinator-events.js';
import { createTerminalWorkspaceCoordinator } from './coordinator.js';
import { createTerminalDiagnosticsCollector } from './diagnostics.js';
import type { TerminalPresentationWorkspace } from './workspace-context.js';

const identity = { kind: 'agent_session', sessionId: 7 } as const;
const placement = { worktreeId: 1, surfaceId: 2, paneId: 3 } as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup(t: TestContext, fetches: ReturnType<typeof deferred<DurableSessionInventory>>[]) {
  const cache = createTerminalPresentationCache<TerminalPresentationController>({
    settings: terminalSettingsDefaults.cache,
  });
  // The cache owns timers and subscriptions; whoever creates one disposes it, or the test
  // process stays alive holding them.
  t.after(() => cache.dispose());
  const session = cache.ensureSession(identity, placement);
  const diagnostics = createTerminalDiagnosticsCollector();
  const workspace = {
    cache,
    diagnostics,
    settings: terminalSettingsDefaults,
    parkingRoot: {} as HTMLDivElement,
    dispose: () => {},
    start: () => {},
    onAttachmentEvent: () => {},
  } as TerminalPresentationWorkspace;
  let index = 0;
  const queryClient = new QueryClient();
  const coordinator = createTerminalWorkspaceCoordinator({
    workspace,
    queryClient,
    fetchInventory: () => fetches[index++]!.promise,
  });
  t.after(() => coordinator.dispose());
  coordinator.start();
  return { cache, coordinator, diagnostics, queryClient, session };
}

describe('terminal workspace inventory reconciliation', () => {
  it('cannot invalidate an ABA-recreated incarnation from a stale response', async (t) => {
    const first = deferred<DurableSessionInventory>();
    const second = deferred<DurableSessionInventory>();
    const { cache, coordinator, session } = setup(t, [first, second]);
    session.invalidate();
    cache.ensureSession(identity, placement);
    first.resolve({ sessions: [] });
    await Promise.resolve();
    second.resolve({ sessions: [{ ...identity, worktreeId: 1 }] });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(cache.getSnapshot().entries.length, 1);
    coordinator.dispose();
  });

  it('rejects conflicting duplicate identities without invalidating', async (t) => {
    const request = deferred<DurableSessionInventory>();
    const { cache, coordinator, diagnostics } = setup(t, [request]);
    request.resolve({
      sessions: [
        { ...identity, worktreeId: 1 },
        { ...identity, worktreeId: 2 },
      ],
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(cache.getSnapshot().entries.length, 1);
    assert.equal(diagnostics.getSnapshot().recent.at(-1)?.reason, 'conflicting_duplicate_identity');
    coordinator.dispose();
  });

  it('rejects a deletion event carrying the wrong durable scope', (t) => {
    const request = deferred<DurableSessionInventory>();
    const { cache, coordinator, diagnostics } = setup(t, [request]);
    publishTerminalWorkspaceFact({
      type: 'durable_identity_deleted',
      identity: { ...identity, worktreeId: 2 },
    });
    assert.equal(cache.getSnapshot().entries.length, 1);
    assert.equal(diagnostics.getSnapshot().recent.at(-1)?.reason, 'delete_event_scope_mismatch');
    coordinator.dispose();
  });

  it('drops a terminal deleted by another client the moment the runtime says so', (t) => {
    const request = deferred<DurableSessionInventory>();
    const { cache } = setup(t, [request]);

    // Nothing local happened here: the runtime published this because a different connected
    // client deleted the worktree that owned the session.
    publishTerminalWorkspaceFact({
      type: 'runtime_event',
      event: {
        id: 'evt-1',
        type: 'durable_session_deleted',
        occurredAt: '2026-07-28T00:00:00.000Z',
        payload: { ...identity, worktreeId: 1 },
      },
    });

    assert.equal(cache.getSnapshot().entries.length, 0);
  });

  it('reconciles away a terminal whose deletion event was missed while disconnected', async (t) => {
    const request = deferred<DurableSessionInventory>();
    const { cache } = setup(t, [request]);

    // The delete landed while the socket was down, so no event ever arrived. Reconnecting
    // sweeps the authoritative inventory, which no longer lists the identity.
    request.resolve({ sessions: [] });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(cache.getSnapshot().entries.length, 0);
  });

  it('aborts inventory on disposal and makes its result inert', async (t) => {
    const request = deferred<DurableSessionInventory>();
    const { cache, coordinator } = setup(t, [request]);
    coordinator.dispose();
    request.resolve({ sessions: [] });
    await Promise.resolve();
    assert.equal(cache.getSnapshot().entries.length, 1);
  });
});

describe('surface projection excludes editor panes', () => {
  // An editor context is a durable entity of another domain: it owns no PTY
  // attachment, so this cache must never mint an identity for it, never let one
  // displace a PTY placement, and never treat one as a reason to drop a PTY
  // entry. The exclusion is structural, so these assertions guard the boundary
  // before any editor projection can reach a client.
  const editorPane = {
    id: 9,
    surfaceId: 2,
    title: 'Editor',
    sortOrder: 1,
    session: {
      kind: 'editor_context',
      editorContext: {
        paneId: 9,
        id: 4,
        worktreeId: 1,
        activePtyProcessId: null,
        attempt: { state: 'none' },
        processStatus: null,
        processDiagnostic: null,
        processDiagnosticDetail: null,
        workbenchReadiness: null,
        readinessDetail: null,
        endpoint: null,
        hasDiagnostics: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  } as const;

  const agentPane = {
    id: placement.paneId,
    surfaceId: placement.surfaceId,
    title: 'Agent',
    sortOrder: 0,
    session: {
      kind: 'agent_session',
      agentSession: {
        id: identity.sessionId,
        paneId: placement.paneId,
        worktreeId: placement.worktreeId,
        harness: 'pi',
        cwd: '/tmp/worktree',
        harnessSessionId: null,
        statusReason: null,
        recoveryAction: 'connect_existing',
        status: 'running',
        diagnosticCode: null,
        diagnosticDetail: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        lastSeenAt: null,
      },
    },
  } as const;

  function publishSurface(queryClient: QueryClient, panes: readonly unknown[]): void {
    queryClient.setQueryData(surfaceDetailQueryKey(placement.surfaceId), {
      id: placement.surfaceId,
      worktreeId: placement.worktreeId,
      title: 'Surface',
      layout: { kind: 'leaf', nodeId: 'n1', paneId: placement.paneId, collapsed: false },
      activePaneId: placement.paneId,
      panes,
    });
  }

  it('registers no identity or placement for an editor pane', async (t) => {
    const { cache, queryClient } = setup(t, [deferred<DurableSessionInventory>()]);
    const before = cache.getSnapshot().entries.length;

    publishSurface(queryClient, [agentPane, editorPane]);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const entries = cache.getSnapshot().entries;
    // The editor added no entry of its own...
    assert.equal(entries.length, before);
    // ...and no entry claims the editor's pane.
    assert.equal(
      entries.some((entry) => entry.placement?.paneId === editorPane.id),
      false,
    );
    // ...and its context id was not misread as a PTY session id.
    assert.equal(
      entries.some((entry) => entry.identity.sessionId === editorPane.session.editorContext.id),
      false,
    );
  });

  it('leaves a neighbouring PTY placement intact when an editor pane appears', async (t) => {
    const { cache, queryClient } = setup(t, [deferred<DurableSessionInventory>()]);

    publishSurface(queryClient, [agentPane, editorPane]);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const entry = cache
      .getSnapshot()
      .entries.find((candidate) => candidate.key === 'agent_session:7');
    assert.ok(entry, 'the agent session entry survives');
    assert.deepEqual(entry.placement, placement);
  });

  it('does not unplace a PTY session merely because an editor pane is present', async (t) => {
    const { cache, queryClient } = setup(t, [deferred<DurableSessionInventory>()]);

    // The agent pane is still in the projection; only the editor is new. A
    // genuine disappearance still unplaces — that is reconciliation working —
    // but an editor's presence is not a disappearance.
    publishSurface(queryClient, [agentPane, editorPane]);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(cache.getSnapshot().entries.length, 1);
    assert.ok(cache.getSnapshot().entries[0]?.placement);
  });
});
