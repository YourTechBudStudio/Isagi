import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { EnsureEditorRuntimeInput, OpenEditorOutput } from '@isagi/contracts';

import { controlPlaneQueryKey } from '../control-plane/queries.js';
import { queryClient } from '../query/client.js';
import { runRuntimeEffect } from '../runtime/run.js';
import { commitLaunchSessionSuccess } from '../workspace/queries.js';
import { surfaceDetailQueryKey } from '../workspace/query-keys.js';
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
 * The runtime's answer is a bare placement — opening an editor deliberately
 * carries no title, because placement is the operation's answer and a title
 * would be a second naming authority over a surface the runtime already named.
 */
export async function openEditorFromPalette(worktreeId: number): Promise<OpenEditorOutput> {
  const output = await runRuntimeEffect(openEditor(worktreeId));
  await commitLaunchSessionSuccess(queryClient, output);
  return output;
}

/**
 * `reuse` on mount, `replace` from a settled pane's action.
 *
 * It takes the surface id as well as the context id so it can own its own
 * invalidation from its arguments rather than reaching for ambient state. The
 * response is the operation's immediate answer and is deliberately **not**
 * written into the cache: surface detail is the authoritative projection, and
 * patching it here would fork the truth.
 */
export function useEnsureEditorRuntimeMutation(input: {
  readonly editorContextId: number;
  readonly surfaceId: number;
}) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: EnsureEditorRuntimeInput) =>
      runRuntimeEffect(ensureEditorRuntime(input.editorContextId, body)),
    // Both outcomes: a launch that failed changed the durable attempt record just
    // as much as one that succeeded, and the pane reads that from the projection.
    onSettled: async () => {
      await client.invalidateQueries({ queryKey: surfaceDetailQueryKey(input.surfaceId) });
    },
  });
}

export function editorDiagnosticsQueryKey(
  editorContextId: number,
  ptyProcessId: number | null,
): readonly unknown[] {
  return ['editor', editorContextId, 'diagnostics', ptyProcessId];
}

/**
 * On demand, never on mount: enabled only while the disclosure is open against a
 * known incarnation.
 *
 * The key carries **both** ids, so a response for a superseded incarnation can
 * never be rendered under its replacement and a late in-flight read lands in a
 * key nothing is subscribed to. A null incarnation disables the query rather
 * than standing in a sentinel id the runtime would have to refuse.
 */
export function useEditorDiagnosticsQuery(
  input: { readonly editorContextId: number; readonly ptyProcessId: number | null },
  options: { readonly enabled: boolean },
) {
  return useQuery({
    queryKey: editorDiagnosticsQueryKey(input.editorContextId, input.ptyProcessId),
    enabled: options.enabled && input.ptyProcessId !== null,
    // The retained tail belongs to one dead incarnation; it never changes.
    staleTime: Infinity,
    queryFn: () => {
      if (input.ptyProcessId === null) {
        throw new Error('Editor diagnostics require an incarnation.');
      }
      return runRuntimeEffect(editorDiagnostics(input.editorContextId, input.ptyProcessId));
    },
  });
}

/**
 * Settles on **both** outcomes, unlike the refresh and policy-save mutations
 * beside it.
 *
 * A retry can legitimately be refused with `editor_provisioning_busy` when
 * another client already restarted the work — and at that moment the
 * authoritative state is transient, not the failure this client still has
 * cached. Nothing else would correct it: a cached `failed` gate does not poll,
 * and the runtime event subscription only mounts inside `WorkspacePage`, which
 * this gate is holding closed. Invalidating on success alone would strand the
 * client on a stale failure indefinitely.
 */
export function useRetryEditorProvisioningMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => runRuntimeEffect(retryEditorProvisioning()),
    onSettled: async () => {
      await client.invalidateQueries({ queryKey: controlPlaneQueryKey });
    },
  });
}
