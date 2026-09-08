import { useMutation, useQueryClient } from '@tanstack/react-query';

import { runRuntimeEffect } from '../../../src/lib/runtime/run.js';
import { loadWorkspaceData } from '../../../src/lib/workspace/queries.js';
import { workspaceQueryKey } from '../../../src/lib/workspace/query-keys.js';
import { reconcileWorkspace } from '../../../src/lib/workspace/runtime-data.js';

export type ProjectRecheckResult =
  | { readonly status: 'restored'; readonly projectId: number }
  | { readonly status: 'still_unavailable'; readonly projectId: number };

/**
 * A prototype of the recheck mutation, shaped exactly as program design §7.3
 * specifies. **Declared prototype debt, repaid in phase 08**, which moves this
 * into `lib/workspace/queries.ts` as the production `useRecheckProjectMutation`.
 *
 * It is here rather than stubbed with a timer because the two properties the
 * mock has to demonstrate are both properties of the *sequence*, not of the
 * rendering:
 *
 * 1. The refresh is an awaited read that can fail. `invalidateQueries` is not
 *    one — it swallows the fetch error and resolves either way — so a reconcile
 *    that restored the folder followed by a failed read would settle as a
 *    success against stale missing-project data and be reported as "Still not
 *    there". `fetchQuery` throws, so that outcome reaches the surface as a
 *    failure instead.
 * 2. Both stages sit inside `mutationFn`, so either one failing leaves the
 *    mutation in `isError` and produces *no verdict at all*. The three outcomes
 *    the surface must tell apart are then distinct by construction.
 *
 * The findings the reconcile returns are deliberately ignored. An empty list is
 * returned both when nothing changed and when the project was already present,
 * so it is not evidence of anything; the verdict comes from the fresh read.
 */
export function useRecheckPrototype() {
  const client = useQueryClient();
  return useMutation<ProjectRecheckResult, Error, number>({
    mutationFn: async (projectId) => {
      await runRuntimeEffect(reconcileWorkspace({ projectId }));

      // Writes into the same cache entry the workspace query observes, so the
      // rail and canvas converge on this result without a second invalidation.
      const data = await client.fetchQuery({
        queryKey: workspaceQueryKey,
        queryFn: ({ signal }) => loadWorkspaceData(signal),
        staleTime: 0,
      });

      const project = data.projects.find((candidate) => candidate.id === projectId);
      return project && project.status !== 'missing'
        ? { status: 'restored', projectId }
        : { status: 'still_unavailable', projectId };
    },
  });
}
