import { QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { queryClient } from '../../../src/lib/query/client.js';
import { useWorkspaceStore } from '../../../src/lib/workspace/store.js';
import { Rail } from '../../../src/routes/workspace/Rail.js';
import { FIXTURE_ACTIVE } from './seed.js';

/** Production rail with simulated runtime responses for pointer and recovery tests. */
export function RailReorderApp() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // The rail only expands the active worktree's surfaces, so the surface scope
    // exists at all because of this selection. Set before the first paint the
    // tests look at, and reset on every mount so a reload is deterministic.
    useWorkspaceStore
      .getState()
      .selectWorktree(FIXTURE_ACTIVE.projectId, FIXTURE_ACTIVE.worktreeId);
    setReady(true);
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      {/* The same track the workspace shell gives the rail. A narrower or
          unconstrained column would have the fixture judging a rail the app
          never renders — and would quietly change what truncates. */}
      <div data-fixture-shell className="grid h-screen grid-cols-[236px_1fr] text-fg">
        {ready && <Rail />}
        <p className="mt-auto p-6 font-mono text-[11px] text-fg-subtle opacity-40">
          {'// the production rail, a fake runtime, and nothing else'}
        </p>
      </div>
    </QueryClientProvider>
  );
}
