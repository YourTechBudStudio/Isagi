// The active context has its own key: refreshing the workspace deliberately does not re-read it.
import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import type { ActiveContextOutput } from '@isagi/contracts';

import { keys } from '../../state/keys.js';
import { revalidate } from '../../state/policy.js';
import { invalidateKeys, runApp } from '../../state/runtime.js';
import { flush } from '../../state/testing.js';
import { activeContextAtom, refreshWorkspace, workspaceReadAtom } from '../queries.js';
import { holdWorkspace, project, workspaceSession } from './test-support.js';

test('a workspace-wide refresh does not refresh active context', async (t) => {
  let activeContextReads = 0;
  const { registry, reads } = workspaceSession(
    t,
    [{ projects: [project({ id: 1, name: 'app' })] }],
    {
      api: {
        fetchActiveContext: () =>
          Effect.sync(() => {
            activeContextReads += 1;
            return { activeContext: { projectId: 1, worktreeId: 10 } } as ActiveContextOutput;
          }),
      },
    },
  );
  await holdWorkspace(t, registry);
  t.after(registry.mount(activeContextAtom));
  await flush();
  assert.equal(activeContextReads, 1);

  // Every way the workspace is refreshed: a runtime event, a commit's awaited re-read, and a
  // read-after-write.
  invalidateKeys(registry, [keys.workspace]);
  await flush();
  await runApp(registry, revalidate(workspaceReadAtom));
  await runApp(registry, refreshWorkspace());
  await flush();

  assert.equal(reads(), 4, 'the workspace was re-read three times');
  assert.equal(activeContextReads, 1, 'the active context was not');
});
