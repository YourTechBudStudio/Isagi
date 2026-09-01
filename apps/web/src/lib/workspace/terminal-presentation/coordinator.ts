import type { QueryClient } from '@tanstack/react-query';

import type {
  DurableSessionIdentity,
  DurableSessionInventory,
  SurfaceDetail,
} from '@isagi/contracts';

import { runRuntimeEffect } from '../../runtime/run.js';
import { fetchDurableSessions } from '../runtime-data.js';
import { terminalSessionKey } from '../terminal-cache/index.js';
import {
  subscribeTerminalWorkspaceFacts,
  type TerminalWorkspaceFact,
} from './coordinator-events.js';
import type { TerminalPresentationWorkspace } from './workspace-context.js';

export function createTerminalWorkspaceCoordinator(input: {
  readonly workspace: TerminalPresentationWorkspace;
  readonly queryClient: QueryClient;
  readonly fetchInventory?: ((signal: AbortSignal) => Promise<DurableSessionInventory>) | undefined;
}) {
  const { cache } = input.workspace;
  let disposed = false;
  let requestGeneration = 0;
  let running = false;
  let dirty = false;
  let abort: AbortController | null = null;

  const diagnoseScopeMismatch = (identity: DurableSessionIdentity) => {
    input.workspace.diagnostics.record({
      kind: 'scope_mismatch',
      reason: 'delete_event_scope_mismatch',
      sessionKind: identity.kind,
      sessionId: identity.sessionId,
      worktreeId: identity.worktreeId,
    });
  };

  const deleteIdentity = (identity: DurableSessionIdentity) => {
    const captured = cache
      .captureIncarnations()
      .find((entry) => terminalSessionKey(entry.identity) === terminalSessionKey(identity));
    if (!captured) return;
    if (captured.worktreeId !== identity.worktreeId) {
      diagnoseScopeMismatch(identity);
      return;
    }
    captured.invalidateIfCurrent();
  };

  const refreshInventory = () => {
    if (disposed) return;
    if (running) {
      dirty = true;
      return;
    }
    running = true;
    dirty = false;
    const generation = ++requestGeneration;
    const captured = cache.captureIncarnations();
    const controller = new AbortController();
    abort = controller;
    void input.queryClient
      .fetchQuery({
        queryKey: ['terminal', 'durable-session-inventory', generation],
        staleTime: 0,
        gcTime: 0,
        queryFn: ({ signal }) => {
          const linked = AbortSignal.any([signal, controller.signal]);
          return input.fetchInventory
            ? input.fetchInventory(linked)
            : runRuntimeEffect(fetchDurableSessions(), { signal: linked });
        },
      })
      .then((inventory) => {
        if (disposed || generation !== requestGeneration) return;
        const byKey = new Map<string, number>();
        for (const identity of inventory.sessions) {
          const key = terminalSessionKey(identity);
          const existingScope = byKey.get(key);
          if (existingScope !== undefined && existingScope !== identity.worktreeId) {
            input.workspace.diagnostics.record({
              kind: 'inventory_rejected',
              reason: 'conflicting_duplicate_identity',
              sessionKind: identity.kind,
              sessionId: identity.sessionId,
              worktreeId: identity.worktreeId,
            });
            return;
          }
          byKey.set(key, identity.worktreeId);
        }
        for (const incarnation of captured) {
          const scope = byKey.get(terminalSessionKey(incarnation.identity));
          if (scope !== undefined && scope !== incarnation.worktreeId) {
            input.workspace.diagnostics.record({
              kind: 'inventory_rejected',
              reason: 'scope_mismatch',
              sessionKind: incarnation.identity.kind,
              sessionId: incarnation.identity.sessionId,
              worktreeId: scope,
            });
            return;
          }
        }
        for (const incarnation of captured) {
          if (!byKey.has(terminalSessionKey(incarnation.identity))) {
            incarnation.invalidateIfCurrent();
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        if (generation !== requestGeneration) return;
        running = false;
        abort = null;
        if (dirty && !disposed) refreshInventory();
      });
  };

  const handleFact = (fact: TerminalWorkspaceFact) => {
    if (disposed) return;
    if (fact.type === 'runtime_connected' || fact.type === 'durable_inventory_refresh_requested') {
      refreshInventory();
      return;
    }
    if (fact.type === 'durable_worktree_deleted') {
      cache.invalidateWorktree(fact.worktreeId);
      refreshInventory();
      return;
    }
    if (fact.type === 'durable_identity_deleted') {
      deleteIdentity(fact.identity);
      return;
    }
    if (fact.type === 'placement_removed') {
      for (const entry of cache.getSnapshot().entries) {
        if (
          entry.placement?.worktreeId === fact.worktreeId &&
          entry.placement.surfaceId === fact.surfaceId &&
          (fact.paneId === undefined || entry.placement.paneId === fact.paneId)
        ) {
          cache.getSessionAtPlacement(entry.placement)?.unplace();
        }
      }
      return;
    }
    const event = fact.event;
    if (event.type === 'durable_session_deleted') {
      deleteIdentity(event.payload);
      return;
    }
    if (event.type === 'agent_session_changed' || event.type === 'terminal_session_changed') {
      const identity =
        event.type === 'agent_session_changed'
          ? { kind: 'agent_session' as const, sessionId: event.payload.agentSessionId }
          : { kind: 'terminal_session' as const, sessionId: event.payload.terminalSessionId };
      const incarnation = cache
        .captureIncarnations()
        .find((entry) => terminalSessionKey(entry.identity) === terminalSessionKey(identity));
      if (!incarnation || incarnation.worktreeId !== event.payload.worktreeId) return;
      cache.getSession(identity)?.movePlacement({
        worktreeId: event.payload.worktreeId,
        surfaceId: event.payload.surfaceId,
        paneId: event.payload.paneId,
      });
      return;
    }
    if (
      event.type === 'surface_changed' &&
      (event.payload.change === 'deleted' || event.payload.change === 'pane_deleted')
    ) {
      const deletedPanes = new Set(event.payload.deletedPaneIds);
      for (const entry of cache.getSnapshot().entries) {
        if (!entry.placement || entry.placement.surfaceId !== event.payload.surfaceId) continue;
        if (event.payload.change === 'deleted' || deletedPanes.has(entry.placement.paneId)) {
          cache.getSessionAtPlacement(entry.placement)?.unplace();
        }
      }
    }
  };

  const applySurfaceProjection = (surface: SurfaceDetail) => {
    const placementByIdentity = new Map<
      string,
      { readonly worktreeId: number; readonly surfaceId: number; readonly paneId: number }
    >();
    for (const pane of surface.panes) {
      if (!pane.session) continue;
      // This cache holds PTY attachments. An editor context is a durable entity
      // of another domain with no attachment to place, so it contributes no
      // identity here; it must not be folded into the terminal vocabulary.
      if (pane.session.kind === 'editor_context') continue;
      const identity =
        pane.session.kind === 'agent_session'
          ? { kind: 'agent_session' as const, sessionId: pane.session.agentSession.id }
          : { kind: 'terminal_session' as const, sessionId: pane.session.terminalSession.id };
      placementByIdentity.set(terminalSessionKey(identity), {
        worktreeId: surface.worktreeId,
        surfaceId: surface.id,
        paneId: pane.id,
      });
    }
    for (const entry of cache.getSnapshot().entries) {
      if (entry.placement?.surfaceId !== surface.id) continue;
      const placement = placementByIdentity.get(entry.key);
      const session = cache.getSession(entry.identity);
      if (!session) continue;
      if (!placement) session.unplace();
      else session.movePlacement(placement);
    }
  };

  const unsubscribeFacts = subscribeTerminalWorkspaceFacts(handleFact);
  const unsubscribeQueries = input.queryClient.getQueryCache().subscribe((event) => {
    const key = event.query.queryKey;
    const data = event.query.state.data;
    if (
      key[0] === 'surface' &&
      data &&
      typeof data === 'object' &&
      'id' in data &&
      'worktreeId' in data &&
      'panes' in data
    ) {
      applySurfaceProjection(data as SurfaceDetail);
    }
  });
  const unsubscribeMembership = cache.subscribeMembership(() => {
    if (running) dirty = true;
  });
  return {
    start: refreshInventory,
    refreshInventory,
    dispose() {
      if (disposed) return;
      disposed = true;
      requestGeneration += 1;
      abort?.abort();
      abort = null;
      unsubscribeFacts();
      unsubscribeQueries();
      unsubscribeMembership();
    },
  };
}
