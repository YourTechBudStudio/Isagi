import type { Effect } from 'effect';
import { useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { useRegistry } from '../../state/registry.js';
import { runApp } from '../../state/runtime.js';
import { paneFocusAllowed } from '../activation.js';
import {
  type TerminalPlacement,
  type TerminalSessionIdentity,
  type TerminalVisibilityAcquisition,
} from '../terminal-cache/index.js';
import {
  decideTerminalAttachment,
  presentationOutlivedIncarnation,
  rejoinRefusal,
  type DecidedTerminalAttachment,
} from './attachment-decision.js';
import type {
  TerminalAttachmentMilestoneObserver,
  TerminalAttachmentSnapshot,
  TerminalPresentationController,
} from './controller.js';
import { useEnsuredTerminalSession } from './ensured-session.js';
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
  processIncarnation: null,
  readiness: Object.freeze({ phase: 'covered' }),
});

export function useTerminalAttachmentResource(input: {
  readonly identity: TerminalSessionIdentity | null;
  readonly placement: TerminalPlacement;
  /**
   * Transport intent: open (or reopen) this session's socket. It collapses the moment a
   * session exits or drops, which is why it must not decide retention.
   */
  readonly connect: boolean;
  /**
   * Rendering presence: this pane is on screen and will mount whatever terminal the cache
   * holds for this session — a live one, or the sealed final output left behind by an exit.
   * Retention keys off this, so a terminal a user can still see is never an eviction
   * candidate.
   */
  readonly mounted: boolean;
  /**
   * The session's live process incarnation as the runtime projects it, or `null` when none is
   * live. A cached presentation bound to a different incarnation has outlived its process, and a
   * change re-runs the attach decision even while the pane stays mounted.
   */
  readonly processIncarnation: string | null;
  readonly attachmentRequest: number;
  readonly initiallyInteractive: boolean;
  /**
   * Claims the session and resolves its socket URL. `expectedProcessIncarnation` makes it an
   * automatic re-attach, which the runtime refuses rather than launch a process for.
   */
  readonly resolveUrl: (options?: {
    readonly expectedProcessIncarnation?: string | undefined;
  }) => Effect.Effect<string, Error>;
  /**
   * The runtime refused an automatic re-attach because the projected incarnation is no longer
   * live. The pane keeps the final output it shows and re-reads its projection.
   */
  readonly onStaleProjection: () => void;
  readonly onCustomKey?:
    | ((event: KeyboardEvent, sendInput: (data: string) => void) => boolean)
    | undefined;
  readonly onMilestone?: TerminalAttachmentMilestoneObserver | undefined;
}) {
  const registry = useRegistry();
  const workspace = useTerminalPresentationWorkspace();
  const identityKey = input.identity
    ? `${input.identity.kind}:${input.identity.sessionId}`
    : 'none';
  const session = useEnsuredTerminalSession(workspace.cache, input.identity, input.placement);
  // React state, not a ref: preparation resolves outside React's knowledge, and
  // the cache publication that accompanies installation may be rendered before
  // this value is written. A ref write would schedule no render and could strand
  // a fully built terminal; a state write always reaches the pane.
  //
  // Keyed by request, not identity: a retry epoch or a new process incarnation
  // can dispose the previous controller, so an identity-keyed value would hand a
  // pane the controller the cache has already torn down.
  const requestKey = `${identityKey}:${input.processIncarnation ?? 'none'}:${input.attachmentRequest}`;
  const [preparedResource, setPreparedResource] = useState<{
    readonly requestKey: string;
    readonly value: TerminalPresentationController;
  } | null>(null);
  const startedRequestRef = useRef<
    | (DecidedTerminalAttachment & {
        /** The preparation this decision started, if any, so a later decision cancels it. */
        readonly attempt: symbol | null;
      })
    | null
  >(null);
  const [failure, setFailure] = useState<{
    readonly identityKey: string;
    readonly value: TerminalPresentationFailure;
  } | null>(null);
  // The automatic rejoin for this request failed for a reason other than a deliberate refusal.
  const [rejoinFailedRequest, setRejoinFailedRequest] = useState<string | null>(null);

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

  // Read from the mounted presentation so that one which outlives its process after its request
  // was decided (its stream ended only once the projection already named the new incarnation)
  // still re-runs the attach decision, which re-checks the cache before acting.
  const mountedOutlived = presentationOutlivedIncarnation(
    resourceSnapshot,
    input.processIncarnation,
  );

  useEffect(() => {
    if (!input.connect || !input.identity || !session) return;
    const request = {
      requestKey,
      identityKey,
      attachmentRequest: input.attachmentRequest,
      processIncarnation: input.processIncarnation,
    };
    const decision = decideTerminalAttachment({
      previous: startedRequestRef.current,
      request,
      mountedOutlived,
      readCached: () => {
        const existing = session.acquireVisibility(input.placement);
        if (existing.status !== 'acquired') return null;
        existing.lease.release();
        return existing.resource;
      },
    });
    if (decision.type === 'keep') return;
    if (decision.type === 'reuse') {
      startedRequestRef.current = { ...request, attempt: null, replacedOutlived: false };
      setPreparedResource({ requestKey, value: decision.resource });
      return;
    }
    const attempt = Symbol(requestKey);
    startedRequestRef.current = {
      ...request,
      attempt,
      replacedOutlived: decision.replacesOutlived,
    };
    // Superseded by a newer decision, not by an effect teardown: a StrictMode
    // probe re-runs this effect with the same request key and must not cancel
    // the preparation it is about to reuse.
    const isCancelled = () => startedRequestRef.current?.attempt !== attempt;
    const identity = input.identity;
    const expectedIncarnation = decision.expectedIncarnation;
    if (expectedIncarnation === null) {
      // The controller runs the claim itself; `runApp` binds this app session's services to it.
      beginPresentation((signal) => runApp(registry, input.resolveUrl(), { signal }));
      return;
    }
    // Nobody asked for this attach, so the outlived presentation stays on screen until the runtime
    // has confirmed the projected process is still live: claim first, dispose after. A refusal
    // means the projection is stale, and the final output it would have replaced is kept.
    void runApp(
      registry,
      input.resolveUrl({ expectedProcessIncarnation: expectedIncarnation }),
    ).then(
      (url) => {
        if (!isCancelled()) beginPresentation(() => Promise.resolve(url));
      },
      (error: unknown) => {
        if (isCancelled()) return;
        const refusal = rejoinRefusal(error);
        workspace.diagnostics.record({
          kind: refusal === null ? 'rejoin_failed' : 'rejoin_refused',
          reason: refusal ?? 'rejoin_failed',
          sessionKind: identity.kind,
          sessionId: identity.sessionId,
          worktreeId: input.placement.worktreeId,
        });
        // Either way the final output stays. A stale projection is re-read; a holder elsewhere
        // keeps the process; anything else is reported, and Reconnect is the retry.
        if (refusal === 'process_incarnation_stale') input.onStaleProjection();
        if (refusal === null) setRejoinFailedRequest(requestKey);
      },
    );

    function beginPresentation(resolveUrl: (signal: AbortSignal) => Promise<string>) {
      if (!session) return;
      const start = session.beginAttachment();
      if (start.status !== 'started') return;
      // The previous epoch's controller is disposed by `beginAttachment`; drop it
      // before the asynchronous preparation window opens.
      setPreparedResource(null);
      setFailure(null);
      setRejoinFailedRequest(null);
      void startTerminalPresentation({
        attachment: start.attachment,
        scrollbackLines: workspace.settings.scrollbackLines,
        initiallyInteractive: input.initiallyInteractive,
        resolveUrl,
        onEvent: (event) => workspace.onAttachmentEvent(identity, event),
        onDiagnostic: (event) =>
          workspace.diagnostics.record({
            kind: event.kind,
            reason: event.kind,
            sessionKind: identity.kind,
            sessionId: identity.sessionId,
            worktreeId: input.placement.worktreeId,
            value: event.value,
          }),
        onGauges: (gauges) => workspace.diagnostics.setGauges(gauges),
        onMilestone: input.onMilestone,
        initialViewport:
          workspace.cache
            .getSnapshot()
            .entries.find(
              (candidate) =>
                candidate.identity.kind === identity.kind &&
                candidate.identity.sessionId === identity.sessionId,
            )?.viewport ?? null,
        onViewport: (viewport) => session.updateViewport(viewport),
        onCustomKey: input.onCustomKey,
        parkingRoot: workspace.parkingRoot,
        environment: workspace.environment ?? browserTerminalEnvironment,
        // The focus scheduler's own rule, bound to this app session: both
        // enforcement points (the focus scheduler and this controller) read the
        // identical owner rule and cannot drift.
        paneFocusAllowed: () => paneFocusAllowed(registry),
        isCancelled,
      }).then((result) => {
        if (result.status === 'started') {
          setPreparedResource({ requestKey, value: result.controller });
          return;
        }
        setPreparedResource((current) => (current?.requestKey === requestKey ? null : current));
        if (result.status === 'failed') setFailure({ identityKey, value: result.failure });
      });
    }
  }, [
    input.connect,
    input.attachmentRequest,
    input.processIncarnation,
    input.identity?.kind,
    input.identity?.sessionId,
    input.initiallyInteractive,
    input.resolveUrl,
    input.onCustomKey,
    input.onMilestone,
    input.onStaleProjection,
    mountedOutlived,
    registry,
    session,
    workspace.settings.scrollbackLines,
  ]);

  // Held for as long as the pane is mounted, not for as long as it is connected. An exited
  // session clears its connect intent while `PtyPane` keeps rendering the sealed terminal as
  // final output; releasing here would hand retention a resource that is still on screen.
  useEffect(() => {
    if (!session || !input.mounted) {
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
    input.mounted,
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

  return {
    resource,
    snapshot: resourceSnapshot,
    entry,
    failure: failure?.identityKey === identityKey && !resource ? failure.value : null,
    /** An automatic rejoin failed (not refused): the pane still shows its final output. */
    rejoinFailed: rejoinFailedRequest === requestKey,
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
