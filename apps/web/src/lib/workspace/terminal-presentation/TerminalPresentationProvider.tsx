import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';

import type { TerminalSettings } from '@isagi/contracts';

import { controlPlaneQueryKey } from '../../control-plane/queries.js';
import { RuntimeApiError } from '../../runtime/client.js';
import { unwrapRuntimeFailure } from '../../runtime/run.js';
import { isLaunchBlockCode } from '../pane-session/view.js';
import { surfaceDetailQueryKey } from '../query-keys.js';
import { createTerminalPresentationCache } from '../terminal-cache/index.js';
import { createScopedLifecycle } from '../terminal-cache/scoped-lifecycle.js';
import type { TerminalPresentationController } from './controller.js';
import { createTerminalWorkspaceCoordinator } from './coordinator.js';
import { createTerminalDiagnosticsCollector } from './diagnostics.js';
import {
  TerminalPresentationContext,
  type TerminalPresentationWorkspace,
} from './workspace-context.js';

/** Owns one in-memory terminal presentation cache for the current workspace boundary. */
export function TerminalPresentationProvider({
  settings,
  children,
}: {
  readonly settings: TerminalSettings;
  readonly children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const workspace = useMemo<TerminalPresentationWorkspace>(() => {
    const lifecycle = createScopedLifecycle();
    const parkingRoot = document.createElement('div');
    parkingRoot.hidden = true;
    parkingRoot.inert = true;
    parkingRoot.setAttribute('aria-hidden', 'true');
    parkingRoot.dataset.terminalParkingRoot = '';
    const diagnostics = createTerminalDiagnosticsCollector();
    const cache = createTerminalPresentationCache<TerminalPresentationController>({
      settings: settings.cache,
      onDiagnostic: (diagnostic) =>
        diagnostics.record({
          kind: diagnostic.kind,
          reason:
            diagnostic.kind === 'operation_rejected'
              ? diagnostic.result
              : diagnostic.kind === 'resource_dispose_failed'
                ? diagnostic.reason
                : diagnostic.kind === 'presentation_evicted'
                  ? diagnostic.reason
                  : diagnostic.kind,
          ...('estimatedBytes' in diagnostic ? { value: diagnostic.estimatedBytes } : {}),
        }),
    });
    const publishCacheGauges = () => {
      const snapshot = cache.getSnapshot();
      diagnostics.setGauges({
        entryCount: snapshot.entries.length,
        visibleLeases: snapshot.entries.reduce(
          (total, entry) => total + entry.visibilityLeaseCount,
          0,
        ),
        hiddenCount: snapshot.entries.filter(
          (entry) => !entry.visible && entry.lifecycle !== 'cold',
        ).length,
        activeSockets: snapshot.entries.filter(
          (entry) => entry.lifecycle === 'hot' || entry.lifecycle === 'preparing',
        ).length,
        estimatedBytes: snapshot.totalEstimatedBytes,
      });
    };
    publishCacheGauges();
    lifecycle.addFinalizer(cache.subscribe(publishCacheGauges));
    lifecycle.addFinalizer(() => parkingRoot.remove());
    lifecycle.addFinalizer(() => cache.dispose());
    let start = () => {};
    const ownedWorkspace: TerminalPresentationWorkspace = {
      cache,
      parkingRoot,
      settings,
      diagnostics,
      start: () => start(),
      dispose: lifecycle.dispose,
      onAttachmentEvent(identity, event) {
        if (event.type === 'sealed') {
          const placement = cache
            .getSnapshot()
            .entries.find(
              (entry) =>
                entry.identity.kind === identity.kind &&
                entry.identity.sessionId === identity.sessionId,
            )?.placement;
          if (placement) {
            void queryClient.invalidateQueries({
              queryKey: surfaceDetailQueryKey(placement.surfaceId),
            });
          }
          return;
        }
        if (event.type !== 'resolve_failed') return;
        const failure = unwrapRuntimeFailure(event.error);
        if (
          failure instanceof RuntimeApiError &&
          failure.apiError.code === 'session_launch_rejected' &&
          isLaunchBlockCode(readErrorReason(failure.apiError.data))
        ) {
          void queryClient.invalidateQueries({ queryKey: controlPlaneQueryKey });
        }
      },
    };
    const coordinator = createTerminalWorkspaceCoordinator({
      workspace: ownedWorkspace,
      queryClient,
    });
    start = coordinator.start;
    lifecycle.addFinalizer(coordinator.dispose);
    return ownedWorkspace;
  }, [
    queryClient,
    settings.scrollbackLines,
    settings.cache.idleTtlMinutes,
    settings.cache.maxHiddenSessions,
    settings.cache.maxEstimatedBufferMiB,
  ]);
  const mountedWorkspacesRef = useRef(new Set<TerminalPresentationWorkspace>());

  useEffect(() => {
    mountedWorkspacesRef.current.add(workspace);
    document.body.append(workspace.parkingRoot);
    workspace.start();
    return () => {
      mountedWorkspacesRef.current.delete(workspace);
      queueMicrotask(() => {
        if (mountedWorkspacesRef.current.has(workspace)) return;
        workspace.dispose();
      });
    };
  }, [workspace]);

  return (
    <TerminalPresentationContext.Provider value={workspace}>
      {children}
    </TerminalPresentationContext.Provider>
  );
}

function readErrorReason(data: unknown): string | null {
  if (!data || typeof data !== 'object' || !('reason' in data)) return null;
  const reason = (data as { readonly reason?: unknown }).reason;
  return typeof reason === 'string' ? reason : null;
}
