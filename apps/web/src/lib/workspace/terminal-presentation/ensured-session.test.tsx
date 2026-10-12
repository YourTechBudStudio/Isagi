import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { terminalSettingsDefaults } from '@isagi/contracts';

import {
  createTerminalPresentationCache,
  type TerminalPresentationCache,
  type TerminalPresentationResource,
} from '../terminal-cache/index.js';
import { useEnsuredTerminalSession } from './ensured-session.js';

function Pane({
  cache,
}: {
  readonly cache: TerminalPresentationCache<TerminalPresentationResource>;
}) {
  const session = useEnsuredTerminalSession(
    cache,
    { kind: 'terminal_session', sessionId: 9 },
    { worktreeId: 1, surfaceId: 2, paneId: 3 },
  );
  return <span data-session={session ? 'ensured' : 'pending'} />;
}

describe('useEnsuredTerminalSession', () => {
  // A cache write made while rendering re-renders every other pane subscribed to the cache in the
  // middle of this pane's render. The server renderer runs no effects, so anything it leaves in the
  // cache was written during render.
  it('never writes the presentation cache while rendering', (t) => {
    const cache = createTerminalPresentationCache<TerminalPresentationResource>({
      settings: terminalSettingsDefaults.cache,
    });
    t.after(() => cache.dispose());
    let notifications = 0;
    cache.subscribe(() => (notifications += 1));

    const markup = renderToStaticMarkup(<Pane cache={cache} />);

    assert.match(markup, /data-session="pending"/);
    assert.equal(notifications, 0);
    assert.deepEqual(cache.getSnapshot().entries, []);
  });
});
