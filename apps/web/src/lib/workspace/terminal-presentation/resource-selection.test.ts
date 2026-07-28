import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Effect } from 'effect';

import { terminalSettingsDefaults } from '@isagi/contracts';

import { createTerminalPresentationCache } from '../terminal-cache/index.js';
import type { TerminalPresentationController } from './controller.js';
import { selectPresentationResource } from './resource-selection.js';
import { startTerminalPresentation } from './start-presentation.js';
import { createFakeTerminalEnvironment } from './test-environment.js';

const PLACEMENT = { worktreeId: 1, surfaceId: 2, paneId: 3 } as const;
const IDENTITY = { kind: 'agent_session', sessionId: 7 } as const;

describe('presentation resource selection', () => {
  it('mounts the controller installed after visibility was already acquired', async () => {
    const env = createFakeTerminalEnvironment();
    const cache = createTerminalPresentationCache<TerminalPresentationController>({
      settings: terminalSettingsDefaults.cache,
    });
    const session = cache.ensureSession(IDENTITY, PLACEMENT);
    const started = session.beginAttachment();
    if (started.status !== 'started') throw new Error('Expected attachment.');

    const preparing = startTerminalPresentation({
      attachment: started.attachment,
      scrollbackLines: 1000,
      initiallyInteractive: true,
      parkingRoot: env.parkingRoot,
      environment: env,
      onEvent: () => undefined,
      resolveUrl: () => Effect.succeed('ws://runtime.test/pty/7'),
      isCancelled: () => false,
    });

    // The pane becomes visible while the entry is still preparing: a perfectly
    // current lease that captured no resource, and nothing to show yet.
    const acquisition = session.acquireVisibility(PLACEMENT);
    if (acquisition.status !== 'acquired') throw new Error('Expected visibility lease.');
    assert.equal(acquisition.resource, null);
    assert.equal(selectPresentationResource({ acquisition, prepared: null }), null);

    env.resolveFonts();
    const result = await preparing;
    if (result.status !== 'started') throw new Error('Expected a prepared controller.');

    // Installing the controller does not bump the attachment epoch, so this
    // lease is never reacquired and its captured `null` never refreshes. The
    // pane must still mount the terminal that now exists.
    assert.equal(acquisition.resource, null, 'the lease keeps its acquisition-time snapshot');
    assert.equal(
      selectPresentationResource({ acquisition, prepared: result.controller }),
      result.controller,
    );

    // A fresh lease sees it through the cache, and both routes agree.
    const reacquired = session.acquireVisibility(PLACEMENT);
    if (reacquired.status !== 'acquired') throw new Error('Expected visibility lease.');
    assert.equal(reacquired.resource, result.controller);
    assert.equal(
      selectPresentationResource({ acquisition: reacquired, prepared: result.controller }),
      result.controller,
    );

    reacquired.lease.release();
    acquisition.lease.release();
    cache.dispose();
  });

  it('shows nothing when the lease itself was rejected', () => {
    const controller = {} as TerminalPresentationController;
    assert.equal(
      selectPresentationResource({ acquisition: { status: 'stale' }, prepared: controller }),
      null,
    );
    assert.equal(
      selectPresentationResource({ acquisition: { status: 'placement_mismatch' }, prepared: null }),
      null,
    );
  });
});
