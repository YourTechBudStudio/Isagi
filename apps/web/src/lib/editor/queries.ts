import { Duration, Effect } from 'effect';
import { Atom } from 'effect/reactivity';

import type { EnsureEditorRuntimeInput } from '@isagi/contracts';

import { controlPlaneQuery } from '../control-plane/queries.js';
import { query, revalidate } from '../state/policy.js';
import { appRuntime } from '../state/runtime.js';
import { commitLaunchSessionSuccess } from '../workspace/commits.js';
import { surfaceDetailAtom } from '../workspace/queries.js';
import {
  editorDiagnostics,
  ensureEditorRuntime,
  openEditor,
  retryEditorProvisioning,
} from '../workspace/runtime-data.js';

/**
 * The palette's entry point, shaped like `startTerminalSessionFromPalette`: call
 * the operation, then settle through the one workspace commit that already
 * fetches the snapshot and activates the placed pane correctly.
 *
 * `intoSurfaceId` names an empty surface to place a not-yet-placed editor in.
 * An editor that is already placed is focused where it is, never moved.
 *
 * The runtime's answer is a bare placement — opening an editor deliberately
 * carries no title, because placement is the operation's answer and a title
 * would be a second naming authority over a surface the runtime already named.
 */
export const openEditorFromPalette = Effect.fn('openEditorFromPalette')(function* (
  worktreeId: number,
  intoSurfaceId: number | null = null,
) {
  const output = yield* Effect.uninterruptible(openEditor(worktreeId, { intoSurfaceId }));
  yield* commitLaunchSessionSuccess(output);
  return output;
});

/**
 * `reuse` on mount, `replace` from a settled pane's action. One fn atom per mounted editor
 * context (build it with `useMemo` on both ids), so its pending state belongs to that pane.
 *
 * It takes the surface id as well as the context id so it can own its own
 * invalidation from its arguments rather than reaching for ambient state. The
 * response is the operation's immediate answer and is deliberately **not**
 * written into the cache: surface detail is the authoritative projection, and
 * patching it here would fork the truth.
 *
 * The request is uninterruptible: a second ensure or an unmount must not abort a launch that
 * already reached the runtime (the old mutation never cancelled its request either).
 */
export const makeEnsureEditorRuntimeAtom = (editorContextId: number, surfaceId: number) =>
  appRuntime.fn((body: EnsureEditorRuntimeInput) =>
    Effect.uninterruptible(ensureEditorRuntime(editorContextId, body)).pipe(
      // Both outcomes: a launch that failed changed the durable attempt record just
      // as much as one that succeeded, and the pane reads that from the projection.
      // The re-read is awaited, so the pane stays "starting" until it lands.
      Effect.ensuring(revalidate(surfaceDetailAtom(surfaceId))),
    ),
  );

/**
 * On demand, never on mount: read only while the disclosure is open against a
 * known incarnation (select `disabledQuery` otherwise).
 *
 * The key carries **both** ids, so a response for a superseded incarnation can
 * never be rendered under its replacement and a late in-flight read lands in a
 * node nothing is subscribed to. A null incarnation has no member here at all,
 * rather than a sentinel id the runtime would have to refuse.
 *
 * The retained tail belongs to one dead incarnation; it never changes, so it is never stale.
 */
export const editorDiagnosticsAtom = Atom.family(
  ([editorContextId, ptyProcessId]: readonly [editorContextId: number, ptyProcessId: number]) =>
    query(() => editorDiagnostics(editorContextId, ptyProcessId), {
      keys: [],
      staleTime: Duration.infinity,
    }),
);

/**
 * Settles on **both** outcomes, unlike the refresh and policy-save paths
 * beside it. One fn atom per mounted gate (build it with `useMemo`).
 *
 * A retry can legitimately be refused with `editor_provisioning_busy` when
 * another client already restarted the work — and at that moment the
 * authoritative state is transient, not the failure this client still has
 * cached. Nothing else would correct it: a cached `failed` gate does not poll,
 * and the runtime event subscription only mounts inside `WorkspacePage`, which
 * this gate is holding closed. Refreshing on success alone would strand the
 * client on a stale failure indefinitely.
 */
export const makeRetryEditorProvisioningAtom = () =>
  appRuntime.fn(() =>
    Effect.uninterruptible(retryEditorProvisioning()).pipe(
      Effect.ensuring(revalidate(controlPlaneQuery)),
    ),
  );
