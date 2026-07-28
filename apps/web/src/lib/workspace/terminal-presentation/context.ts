import type { Effect } from 'effect';
import { useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import {
  type TerminalPlacement,
  type TerminalSessionIdentity,
  type TerminalVisibilityAcquisition,
} from '../terminal-cache/index.js';
import type { TerminalAttachmentSnapshot, TerminalPresentationController } from './controller.js';
import { browserTerminalEnvironment } from './environment.js';
import { selectPresentationResource } from './resource-selection.js';
import {
  startTerminalPresentation,
  type TerminalPresentationFailure,
} from './start-presentation.js';
import { TerminalPresentationContext } from './workspace-context.js';

const idleSnapshot: TerminalAttachmentSnapshot = Object.freeze({
  phase: 'connecting',
  notice: null,
  exit: Object.freeze({ exitCode: null, signal: null }),
  interactive: false,
  rendererWarning: null,
  sealReason: null,
});

export function useTerminalAttachmentResource(input: {
  readonly identity: TerminalSessionIdentity | null;
  readonly placement: TerminalPlacement;
  readonly enabled: boolean;
  readonly attachmentRequest: number;
  readonly initiallyInteractive: boolean;
  readonly resolveUrl: () => Effect.Effect<string, Error>;
  readonly onCustomKey?:
    | ((event: KeyboardEvent, sendInput: (data: string) => void) => boolean)
    | undefined;
}) {
  const workspace = useTerminalPresentationWorkspace();
  const identityKey = input.identity
    ? `${input.identity.kind}:${input.identity.sessionId}`
    : 'none';
  const session = useMemo(
    () => (input.identity ? workspace.cache.ensureSession(input.identity, input.placement) : null),
    [workspace.cache, input.identity?.kind, input.identity?.sessionId],
  );
  // React state, not a ref: preparation resolves outside React's knowledge, and
  // the cache publication that accompanies installation may be rendered before
  // this value is written. A ref write would schedule no render and could strand
  // a fully built terminal; a state write always reaches the pane.
  //
  // Keyed by request, not identity: a retry epoch disposes the previous
  // controller, so an identity-keyed value would hand a pane the controller the
  // cache has already torn down.
  const requestKey = `${identityKey}:${input.attachmentRequest}`;
  const [preparedResource, setPreparedResource] = useState<{
    readonly requestKey: string;
    readonly value: TerminalPresentationController;
  } | null>(null);
  const startedRequestRef = useRef<string | null>(null);
  const [failure, setFailure] = useState<{
    readonly identityKey: string;
    readonly value: TerminalPresentationFailure;
  } | null>(null);

  useEffect(() => {
    const current = workspace.cache.getSessionAtPlacement(input.placement);
    if (!input.identity || !session) return;
    if (
      current?.identity.kind !== input.identity.kind ||
      current.identity.sessionId !== input.identity.sessionId
    ) {
      session.movePlacement(input.placement);
    }
  }, [
    input.placement.worktreeId,
    input.placement.surfaceId,
    input.placement.paneId,
    session,
    workspace.cache,
  ]);

  useEffect(() => {
    if (!input.enabled || !input.identity || !session) return;
    if (startedRequestRef.current === requestKey) return;
    startedRequestRef.current = requestKey;
    const existing = session.acquireVisibility(input.placement);
    if (existing.status === 'acquired') {
      existing.lease.release();
      if (existing.resource && input.attachmentRequest === 0) {
        setPreparedResource({ requestKey, value: existing.resource });
        return;
      }
    }
    const start = session.beginAttachment();
    if (start.status !== 'started') return;
    const identity = input.identity;
    // The previous epoch's controller is disposed by `beginAttachment`; drop it
    // before the asynchronous preparation window opens.
    setPreparedResource(null);
    setFailure(null);
    void startTerminalPresentation({
      attachment: start.attachment,
      scrollbackLines: workspace.settings.scrollbackLines,
      initiallyInteractive: input.initiallyInteractive,
      resolveUrl: input.resolveUrl,
      onEvent: (event) => workspace.onAttachmentEvent(identity, event),
      onCustomKey: input.onCustomKey,
      parkingRoot: workspace.parkingRoot,
      environment: browserTerminalEnvironment,
      // Superseded by a newer request, not by an effect teardown: a StrictMode
      // probe re-runs this effect with the same request key and must not cancel
      // the preparation it is about to reuse.
      isCancelled: () => startedRequestRef.current !== requestKey,
    }).then((result) => {
      if (result.status === 'started') {
        setPreparedResource({ requestKey, value: result.controller });
        return;
      }
      setPreparedResource((current) => (current?.requestKey === requestKey ? null : current));
      if (result.status === 'failed') setFailure({ identityKey, value: result.failure });
    });
  }, [
    input.enabled,
    input.attachmentRequest,
    input.identity?.kind,
    input.identity?.sessionId,
    input.initiallyInteractive,
    input.resolveUrl,
    input.onCustomKey,
    session,
    workspace.settings.scrollbackLines,
  ]);

  const cacheSnapshot = useSyncExternalStore(
    workspace.cache.subscribe,
    workspace.cache.getSnapshot,
  );
  const entry = cacheSnapshot.entries.find(
    (candidate) =>
      candidate.identity.kind === input.identity?.kind &&
      candidate.identity.sessionId === input.identity?.sessionId,
  );
  const [acquiredResource, setAcquiredResource] = useState<{
    readonly identityKey: string;
    readonly acquisition: TerminalVisibilityAcquisition<TerminalPresentationController>;
  } | null>(null);
  useEffect(() => {
    if (!session || !input.enabled) {
      setAcquiredResource(null);
      return;
    }
    const acquisition = session.acquireVisibility(input.placement);
    if (acquisition.status !== 'acquired') {
      setAcquiredResource(null);
      return;
    }
    setAcquiredResource({ identityKey, acquisition });
    return () => acquisition.lease.release();
  }, [
    session,
    input.enabled,
    input.placement.worktreeId,
    input.placement.surfaceId,
    input.placement.paneId,
    entry?.attachmentEpoch,
    // A lease captures the entry's resource at acquisition time, and a pane
    // routinely acquires while the entry is still `preparing`. Reacquiring on
    // the lifecycle transition refreshes that capture, so the lease itself
    // carries the terminal once one exists.
    entry?.lifecycle,
    identityKey,
  ]);
  const currentAcquisition =
    acquiredResource?.identityKey === identityKey ? acquiredResource.acquisition : null;
  const resource = selectPresentationResource({
    acquisition: currentAcquisition,
    prepared: preparedResource?.requestKey === requestKey ? preparedResource.value : null,
  });
  const resourceSnapshot = useSyncExternalStore(
    resource?.subscribe ?? emptySubscribe,
    resource?.getSnapshot ?? (() => idleSnapshot),
  );

  return {
    resource,
    snapshot: resourceSnapshot,
    entry,
    failure: failure?.identityKey === identityKey && !resource ? failure.value : null,
  };
}

function useTerminalPresentationWorkspace() {
  const value = useContext(TerminalPresentationContext);
  if (!value) throw new Error('Terminal presentation cache is unavailable outside its workspace.');
  return value;
}

function emptySubscribe() {
  return () => undefined;
}
